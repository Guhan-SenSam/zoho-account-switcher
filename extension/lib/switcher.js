// Orchestrates account switching on top of the cookie jar, account store,
// site-data helpers and badge. Every operation runs through one internal
// promise-chain mutex, so no two operations ever interleave.

import { signOutReason } from './session-guard.js';

const PENDING_ERROR = 'Finish or cancel adding an account first';
const NOT_PENDING_ERROR = 'No account is being added';

const MAX_LISTED_COOKIES = 3;

// 'Could not restore 2 cookies: IAMX (.zoho.com), zz (mail.zoho.com)'
function restoreWarnings(result) {
  const failed = result?.failed ?? [];
  const n = failed.length;
  if (!n) return [];
  const listed = failed.slice(0, MAX_LISTED_COOKIES).map((f) => `${f.name} (${f.domain})`);
  if (n > MAX_LISTED_COOKIES) listed.push('…');
  return [`Could not restore ${n} ${n === 1 ? 'cookie' : 'cookies'}: ${listed.join(', ')}`];
}

export function createSwitcher({ jar, store, siteData, badge, now = () => Date.now() }) {
  let chain = Promise.resolve();
  let inFlight = 0; // state-touching ops running or queued (what syncActive defers to)
  let userInFlight = 0; // user-initiated ops running or queued (isBusy)

  function run(fn, { user = false, counted = true } = {}) {
    if (counted) inFlight++;
    if (user) userInFlight++;
    const result = chain.then(fn);
    chain = result.catch(() => {});
    return result.finally(() => {
      if (counted) inFlight--;
      if (user) userInFlight--;
    });
  }
  const userOp = (fn) => run(fn, { user: true });
  const bgOp = (fn) => run(fn);
  // Read-only: still serialized (consistent reads) but a sync may queue behind it.
  const readOp = (fn) => run(fn, { counted: false });

  async function updateBadge() {
    try {
      const [accounts, activeId, pending] = await Promise.all([
        store.list(),
        store.getActiveId(),
        store.getPending(),
      ]);
      const active = activeId ? accounts.find((a) => a.id === activeId) ?? null : null;
      await badge.show({ active, pending: Boolean(pending) });
    } catch (err) {
      console.warn('Zoho Account Switcher: badge update failed', err);
    }
  }

  // Deep clean is an optional extra: a failure becomes a warning rather than
  // aborting a half-done switch.
  async function maybeDeepClean(warnings) {
    const settings = await store.getSettings();
    if (!settings?.deepClean) return;
    try {
      await siteData.deepClean();
    } catch (err) {
      warnings.push(`Site data could not be cleared: ${err?.message ?? err}`);
    }
  }

  // After cookies were cleared but before the target became active, the live
  // jar matches no saved account. Put the outgoing account back so a later
  // syncActive() cannot write foreign cookies into it; if even that fails,
  // drop the active account so nothing gets overwritten.
  async function rollback(outgoingCookies) {
    try {
      await jar.clear();
      if (outgoingCookies) await jar.restore(outgoingCookies);
    } catch {
      try { await store.setActiveId(null); } catch { /* nothing more we can do */ }
    }
    try { await store.setSwitching(null); } catch { /* recovery will finish the switch instead */ }
  }

  // The account a sync may write into: none while an add is pending or a switch
  // is in progress (or was, when a crash interrupted it).
  async function syncableActiveId() {
    const activeId = await store.getActiveId();
    if (!activeId || (await store.getPending()) || (await store.getSwitching())) return null;
    return activeId;
  }

  // Writes `live` into the account unless that would replace its saved session
  // with a signed-out jar (external wipe, expired auth cookies, partial restore).
  async function saveUnlessSignedOut(id, live) {
    const account = await store.get(id);
    if (!account) return false;
    const reason = signOutReason(account.cookies ?? [], live);
    if (reason) {
      console.info(`Zoho Account Switcher: kept the saved session of "${account.name}" (live cookies look signed out: ${reason})`);
      return false;
    }
    await store.updateCookies(id, live);
    return true;
  }

  // Returns the live snapshot even when the guard kept the saved copy.
  async function snapshotActiveInto(activeId) {
    const cookies = await jar.snapshot();
    await saveUnlessSignedOut(activeId, cookies);
    return cookies;
  }

  return {
    isBusy() {
      return userInFlight > 0;
    },

    // Any state-changing op (user or background) running or queued: what
    // syncActive defers to. The cookie-sync scheduler waits on this.
    isLocked() {
      return inFlight > 0;
    },

    switchTo(id) {
      return userOp(async () => {
        if (await store.getPending()) throw new Error(PENDING_ERROR);
        const target = await store.get(id);
        if (!target) throw new Error('Unknown account');
        const activeId = await store.getActiveId();
        if (activeId === id) return { warnings: [] };

        const warnings = [];
        const outgoing = activeId ? await snapshotActiveInto(activeId) : null;
        // Until the target is active the jar belongs to no account; the persisted
        // marker stops syncs and lets a restarted worker finish the switch.
        await store.setSwitching({ from: activeId ?? null, to: id, startedAt: now() });
        try {
          await jar.clear();
          await maybeDeepClean(warnings);
          const result = await jar.restore(target.cookies ?? []);
          warnings.push(...restoreWarnings(result));
          await store.setActiveId(id);
        } catch (err) {
          await rollback(outgoing);
          throw err;
        }
        await store.setSwitching(null);
        await updateBadge();
        await siteData.resetTabs();
        return { warnings };
      });
    },

    beginAdd() {
      return userOp(async () => {
        if (await store.getPending()) {
          await siteData.openSignIn();
          return { warnings: [] };
        }
        const warnings = [];
        const activeId = await store.getActiveId();
        const pending = { previousId: activeId ?? null, startedAt: now() };
        if (activeId) {
          await snapshotActiveInto(activeId);
        } else {
          // An unsaved session would be lost by the clear below; keep it for cancelAdd.
          const live = await jar.snapshot();
          if (live.length > 0) pending.previousCookies = live;
        }
        await store.setPending(pending);
        await store.setActiveId(null);
        await updateBadge();
        await jar.clear();
        await maybeDeepClean(warnings);
        await siteData.resetTabs();
        await siteData.openSignIn();
        return { warnings };
      });
    },

    finishAdd(name) {
      return userOp(async () => {
        if (!(await store.getPending())) throw new Error(NOT_PENDING_ERROR);
        const cookies = await jar.snapshot();
        const account = await store.create({ name, cookies }); // throws on a bad name
        await store.setActiveId(account.id);
        await store.setPending(null);
        await updateBadge();
        // Zoho tabs beginAdd signed out: reload them as the new account.
        await siteData.resetTabs();
        return account;
      });
    },

    cancelAdd() {
      return userOp(async () => {
        const pending = await store.getPending();
        if (!pending) throw new Error(NOT_PENDING_ERROR);
        const warnings = [];
        await jar.clear();
        await maybeDeepClean(warnings);
        const previous = pending.previousId ? await store.get(pending.previousId) : null;
        if (previous) {
          const result = await jar.restore(previous.cookies ?? []);
          warnings.push(...restoreWarnings(result));
          await store.setActiveId(previous.id);
        } else {
          if (pending.previousId === null && Array.isArray(pending.previousCookies)) {
            warnings.push(...restoreWarnings(await jar.restore(pending.previousCookies)));
          }
          await store.setActiveId(null);
        }
        await store.setPending(null);
        await updateBadge();
        await siteData.resetTabs();
        return { warnings };
      });
    },

    saveCurrentAs(name) {
      return userOp(async () => {
        if (await store.getPending()) throw new Error(PENDING_ERROR);
        if ((await store.getActiveId()) !== null) throw new Error('An account is already active');
        const cookies = await jar.snapshot();
        const account = await store.create({ name, cookies }); // throws on a bad name
        await store.setActiveId(account.id);
        await updateBadge();
        return account;
      });
    },

    remove(id) {
      return userOp(async () => {
        await store.remove(id);
        await updateBadge();
      });
    },

    syncActive() {
      // Never queue behind (or ahead of) another op: whatever is running will
      // leave the jar in a state that a later sync can capture.
      if (inFlight > 0) return Promise.resolve(false);
      return bgOp(async () => {
        const activeId = await syncableActiveId();
        if (!activeId) return false;
        const cookies = await jar.snapshot();
        // Defensive re-check: only write if the snapshot still belongs to activeId.
        if ((await syncableActiveId()) !== activeId) return false;
        return saveUnlessSignedOut(activeId, cookies);
      });
    },

    restoreActiveOnStartup() {
      return bgOp(async () => {
        let result = null;
        const activeId = await syncableActiveId();
        if (activeId) {
          const active = await store.get(activeId);
          // Only what the restart dropped (session cookies): live values are newer.
          if (active) result = await jar.restore(active.cookies ?? [], { onlyMissing: true });
        }
        await updateBadge();
        // Zoho tabs brought back by session restore loaded signed out.
        if (result?.restored > 0) await siteData.resetTabs();
        return result;
      });
    },

    // A switch interrupted by a crash (marker still set): finish it — restore
    // the target if it still exists, else the outgoing account, else nothing.
    recoverInterruptedSwitch() {
      return bgOp(async () => {
        const marker = await store.getSwitching();
        if (!marker) return null;
        const warnings = [];
        await jar.clear();
        await maybeDeepClean(warnings);
        const account = (await store.get(marker.to)) ?? (marker.from ? await store.get(marker.from) : null);
        if (account) warnings.push(...restoreWarnings(await jar.restore(account.cookies ?? [])));
        await store.setActiveId(account?.id ?? null);
        await store.setSwitching(null);
        await updateBadge();
        await siteData.resetTabs();
        return { activeId: account?.id ?? null, warnings };
      });
    },

    refreshBadge() {
      return readOp(updateBadge);
    },
  };
}
