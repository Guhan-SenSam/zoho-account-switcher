// Orchestrates account switching on top of the cookie jar, account store,
// site-data helpers, badge and (optionally) private windows. Every operation
// runs through one internal promise-chain mutex, so no two operations ever
// interleave.
//
// "Add account" has two modes (pending.mode):
//   'signout' — the original flow: save the active account, sign the browser
//               out, the user signs in to the new account in a normal tab.
//               Any pending without a mode (old data) is this one.
//   'private' — when the extension is allowed in Incognito: the new account
//               signs in in an Incognito window, in its own cookie store,
//               while the active account stays signed in (and synced) in the
//               regular profile. Nothing in the regular jar, activeId or the
//               regular tabs changes until the user switches to the new one.

import { signOutReason } from './session-guard.js';
import { SIGN_IN_URL } from './zoho-domains.js';

const PENDING_ERROR = 'Finish or cancel adding an account first';
const NOT_PENDING_ERROR = 'No account is being added';
const NOTHING_CAPTURED_ERROR = 'Sign in to Zoho in the private window first';
const NOT_ALLOWED_ERROR = 'Turn on “Allow in Incognito” for this extension to reopen the private window, '
  + 'or cancel adding the account';

const isPrivatePending = (pending) => pending?.mode === 'private';

const samePrivateAdd = (a, b) => isPrivatePending(a) && isPrivatePending(b)
  && a.startedAt === b.startedAt && a.windowId === b.windowId && a.storeId === b.storeId;

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

export function createSwitcher({ jar, store, siteData, badge, privateWindows = null, now = () => Date.now() }) {
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

  // The account a sync may write into: none while a sign-out add is pending or
  // a switch is in progress (or was, when a crash interrupted it). A private
  // add leaves the active account signed in, so it keeps syncing.
  async function syncableActiveId() {
    const activeId = await store.getActiveId();
    if (!activeId) return null;
    const pending = await store.getPending();
    if (pending && !isPrivatePending(pending)) return null;
    if (await store.getSwitching()) return null;
    return activeId;
  }

  async function incognitoAllowed() {
    if (!privateWindows) return false;
    try {
      return (await privateWindows.isAllowed()) === true;
    } catch {
      return false;
    }
  }

  async function privateWindowOpen(pending) {
    if (!privateWindows || pending.windowId === null || pending.windowId === undefined) return false;
    try {
      return (await privateWindows.isOpen(pending.windowId)) === true;
    } catch {
      return false;
    }
  }

  // Clean-up after a private add finished or was cancelled: best effort, the
  // add itself is already decided (and closing the last Incognito window drops
  // its store anyway).
  async function discardPrivateSession(pending) {
    try {
      await jar.clear({ storeId: pending.storeId });
    } catch (err) {
      console.warn('Zoho Account Switcher: could not clear the private window’s cookies', err);
    }
    try {
      await privateWindows.close(pending.windowId);
    } catch (err) {
      console.warn('Zoho Account Switcher: could not close the private window', err);
    }
  }

  // Opens a private window on the sign-in page. Its cookie store is shared by
  // every Incognito window, so a leftover Zoho session there would take over
  // the sign-in: clear it before the page loads.
  async function openPrivateSignIn() {
    return privateWindows.open(SIGN_IN_URL, {
      beforeLoad: ({ storeId }) => jar.clear({ storeId }),
    });
  }

  // The cookies a private add saves: the live private store unless it is empty
  // or looks signed out next to an earlier capture (e.g. a reopened window
  // showing the sign-in page), else that capture. null when there is nothing.
  function chooseCaptured(live, captured) {
    const saved = Array.isArray(captured) && captured.length > 0 ? captured : null;
    if (live.length > 0) {
      const reason = saved ? signOutReason(saved, live) : null;
      if (!reason) return live;
      console.info(`Zoho Account Switcher: kept the cookies captured from the private window (the window looks signed out: ${reason})`);
    }
    return saved;
  }

  async function beginPrivateAdd(activeId) {
    const startedAt = now();
    const { windowId, storeId } = await openPrivateSignIn();
    await store.setPending({ mode: 'private', previousId: activeId ?? null, startedAt, windowId, storeId });
    await updateBadge();
    return { warnings: [], mode: 'private' };
  }

  // Already adding privately: show the window, or open a fresh one if it was
  // closed (keeping whatever was captured from the old one).
  async function resumePrivateAdd(pending) {
    if (pending.windowId !== null && (await privateWindows?.focus(pending.windowId))) {
      return { warnings: [], mode: 'private' };
    }
    if (!(await incognitoAllowed())) throw new Error(NOT_ALLOWED_ERROR);
    const { windowId, storeId } = await openPrivateSignIn();
    await store.setPending({ ...pending, windowId, storeId });
    await updateBadge();
    return { warnings: [], mode: 'private' };
  }

  async function beginSignoutAdd() {
    const warnings = [];
    const activeId = await store.getActiveId();
    const pending = { mode: 'signout', previousId: activeId ?? null, startedAt: now() };
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
    return { warnings, mode: 'signout' };
  }

  // Saves the private window's session as a new account. The active account,
  // the regular jar and the regular tabs stay as they are.
  async function finishPrivateAdd(pending, name) {
    const open = await privateWindowOpen(pending);
    const live = open ? await jar.snapshot({ storeId: pending.storeId }) : [];
    const cookies = chooseCaptured(live, pending.capturedCookies);
    if (!cookies) throw new Error(NOTHING_CAPTURED_ERROR);
    const account = await store.create({ name, cookies }); // throws on a bad name
    if (open) await discardPrivateSession(pending);
    await store.setPending(null);
    await updateBadge();
    return account;
  }

  async function finishSignoutAdd(name) {
    const cookies = await jar.snapshot();
    const account = await store.create({ name, cookies }); // throws on a bad name
    await store.setActiveId(account.id);
    await store.setPending(null);
    await updateBadge();
    // Zoho tabs beginAdd signed out: reload them as the new account.
    await siteData.resetTabs();
    return account;
  }

  async function cancelPrivateAdd(pending) {
    if (await privateWindowOpen(pending)) await discardPrivateSession(pending);
    await store.setPending(null);
    await updateBadge();
    return { warnings: [] };
  }

  async function cancelSignoutAdd(pending) {
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

    // -> { warnings, mode: 'private'|'signout' }
    beginAdd() {
      return userOp(async () => {
        const pending = await store.getPending();
        if (isPrivatePending(pending)) return resumePrivateAdd(pending);
        if (pending) {
          await siteData.openSignIn();
          return { warnings: [], mode: 'signout' };
        }
        if (await incognitoAllowed()) return beginPrivateAdd(await store.getActiveId());
        return beginSignoutAdd();
      });
    },

    finishAdd(name) {
      return userOp(async () => {
        const pending = await store.getPending();
        if (!pending) throw new Error(NOT_PENDING_ERROR);
        return isPrivatePending(pending) ? finishPrivateAdd(pending, name) : finishSignoutAdd(name);
      });
    },

    cancelAdd() {
      return userOp(async () => {
        const pending = await store.getPending();
        if (!pending) throw new Error(NOT_PENDING_ERROR);
        return isPrivatePending(pending) ? cancelPrivateAdd(pending) : cancelSignoutAdd(pending);
      });
    },

    // Private add: copy the private window's Zoho cookies into
    // pending.capturedCookies, so Save still works after the window is closed
    // (closing the last Incognito window deletes its cookies). Skipped, like
    // syncActive, while another op runs; never touches accounts or the regular jar.
    capturePrivate() {
      if (inFlight > 0) return Promise.resolve(false);
      return bgOp(async () => {
        const pending = await store.getPending();
        if (!isPrivatePending(pending) || !(await privateWindowOpen(pending))) return false;
        let live;
        try {
          live = await jar.snapshot({ storeId: pending.storeId });
        } catch {
          return false; // the store went away with its window
        }
        if (live.length === 0) return false;
        const captured = pending.capturedCookies ?? [];
        const reason = signOutReason(captured, live);
        if (reason) {
          console.info(`Zoho Account Switcher: kept the cookies captured from the private window (it looks signed out: ${reason})`);
          return false;
        }
        const current = await store.getPending();
        if (!samePrivateAdd(current, pending)) return false;
        await store.setPending({ ...current, capturedCookies: live });
        return true;
      });
    },

    // windows.onRemoved: if it was the private add's window, remember that it
    // is gone (the add stays pending; Save can use the captured cookies).
    privateWindowClosed(windowId) {
      return bgOp(async () => {
        const pending = await store.getPending();
        if (!isPrivatePending(pending) || pending.windowId === null || pending.windowId !== windowId) return false;
        await store.setPending({ ...pending, windowId: null });
        return true;
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
        // Incognito windows never survive a browser restart (and their ids
        // may now name a regular window): a private add's window is gone.
        const pending = await store.getPending();
        if (isPrivatePending(pending) && pending.windowId !== null) {
          await store.setPending({ ...pending, windowId: null });
        }
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
