// Orchestrates account switching on top of the cookie jar, account store,
// site-data helpers and badge. Every operation runs through one internal
// promise-chain mutex, so no two operations ever interleave.

const PENDING_ERROR = 'Finish or cancel adding an account first';
const NOT_PENDING_ERROR = 'No account is being added';

function restoreWarnings(result) {
  const n = result?.failed?.length ?? 0;
  if (!n) return [];
  return [`${n} ${n === 1 ? 'cookie' : 'cookies'} could not be restored`];
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
  }

  async function snapshotActiveInto(activeId) {
    const cookies = await jar.snapshot();
    await store.updateCookies(activeId, cookies);
    return cookies;
  }

  return {
    isBusy() {
      return userInFlight > 0;
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
        if (activeId) await snapshotActiveInto(activeId);
        await store.setPending({ previousId: activeId ?? null, startedAt: now() });
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
        const activeId = await store.getActiveId();
        if (!activeId || (await store.getPending())) return false;
        const cookies = await jar.snapshot();
        // Defensive re-check: only write if the snapshot still belongs to activeId.
        if ((await store.getActiveId()) !== activeId || (await store.getPending())) return false;
        await store.updateCookies(activeId, cookies);
        return true;
      });
    },

    restoreActiveOnStartup() {
      return bgOp(async () => {
        let result = null;
        const activeId = await store.getActiveId();
        if (activeId && !(await store.getPending())) {
          const active = await store.get(activeId);
          if (active) result = await jar.restore(active.cookies ?? []);
        }
        await updateBadge();
        return result;
      });
    },

    refreshBadge() {
      return readOp(updateBadge);
    },
  };
}
