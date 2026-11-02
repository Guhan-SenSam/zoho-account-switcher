// Snapshot / clear / restore every Zoho cookie via chrome.cookies.
// No `chrome` access at import time: the API is passed in (or read lazily from
// globalThis.chrome when createCookieJar() is called).

import { ZOHO_DOMAINS, isZohoCookieDomain } from './zoho-domains.js';

const MAX_CLEAR_PASSES = 3;

/**
 * @typedef {object} SavedCookie
 * @property {string} name
 * @property {string} value
 * @property {string} domain        as Chrome reports it ('.zoho.com' or 'mail.zoho.com')
 * @property {boolean} hostOnly
 * @property {string} path
 * @property {boolean} secure
 * @property {boolean} httpOnly
 * @property {'no_restriction'|'lax'|'strict'|'unspecified'} sameSite
 * @property {boolean} session
 * @property {number} [expirationDate]  only when !session
 * @property {{topLevelSite?: string, hasCrossSiteAncestor?: boolean}} [partitionKey]  only when present
 */

/** chrome.cookies.Cookie -> SavedCookie (drops storeId). */
export function toSavedCookie(c) {
  const saved = {
    name: c.name,
    value: c.value,
    domain: c.domain,
    hostOnly: c.hostOnly,
    path: c.path,
    secure: c.secure,
    httpOnly: c.httpOnly,
    sameSite: c.sameSite,
    session: c.session,
  };
  if (!c.session && c.expirationDate !== undefined) saved.expirationDate = c.expirationDate;
  if (c.partitionKey) saved.partitionKey = { ...c.partitionKey };
  return saved;
}

/**
 * URL the cookie belongs to: `https://${domain sans '.'}${path||'/'}`. Always
 * https (Zoho is HTTPS-only): Chrome won't let an http source set a non-secure
 * cookie that would shadow a Secure one of the same name, which made restores
 * depend on the order of parallel set() calls.
 */
export function cookieUrl(cookie) {
  const host = cookie.domain.startsWith('.') ? cookie.domain.slice(1) : cookie.domain;
  return `https://${host}${cookie.path || '/'}`;
}

/**
 * SavedCookie -> chrome.cookies.set() details. Only properties chrome.cookies.set
 * accepts are emitted (it rejects unknown ones such as hostOnly/session).
 * Host-only cookies get NO domain (a domain would turn them into domain cookies
 * and make __Host- cookies fail); session cookies get no expirationDate.
 */
export function toSetDetails(saved) {
  const details = {
    url: cookieUrl(saved),
    name: saved.name,
    value: saved.value,
    path: saved.path || '/',
    secure: saved.secure,
    httpOnly: saved.httpOnly,
    sameSite: saved.sameSite,
  };
  if (!saved.hostOnly) details.domain = saved.domain;
  if (!saved.session && saved.expirationDate !== undefined) details.expirationDate = saved.expirationDate;
  if (saved.partitionKey) details.partitionKey = { ...saved.partitionKey };
  return details;
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`;
}

const cookieKey = (c) => `${c.name}|${c.domain}|${c.path}|${stableJson(c.partitionKey ?? null)}`;

const errorMessage = (err) => (err instanceof Error ? err.message : String(err));

/** Call `fn` and always get a promise back, even if it throws synchronously. */
const attempt = async (fn) => fn();

export function createCookieJar(api = globalThis.chrome?.cookies, { now = () => Date.now() } = {}) {
  const cookiesApi = () => {
    if (!api) throw new Error('chrome.cookies is not available');
    return api;
  };

  // `storeId` given: that cookie store (the private add flow's Incognito store).
  // Omitted: no storeId is passed, i.e. the background's own (regular) store.
  const inStore = (details, storeId) => (storeId === undefined ? details : { ...details, storeId });

  /** Every live Zoho cookie of the regular store (or `storeId`), partitioned ones included, deduped. */
  async function snapshot({ storeId } = {}) {
    const a = cookiesApi();
    const perDomain = await Promise.all(ZOHO_DOMAINS.map(async (domain) => {
      const [plain, all] = await Promise.all([
        a.getAll(inStore({ domain }, storeId)),
        // partitionKey: {} (no topLevelSite) returns partitioned + unpartitioned
        // cookies (Chrome 119+). Older Chrome rejects the property: ignore.
        attempt(() => a.getAll(inStore({ domain, partitionKey: {} }, storeId))).catch(() => []),
      ]);
      return [...(plain ?? []), ...(all ?? [])];
    }));

    const seen = new Map();
    for (const c of perDomain.flat()) {
      if (!isZohoCookieDomain(c.domain)) continue;
      const key = cookieKey(c);
      if (!seen.has(key)) seen.set(key, toSavedCookie(c));
    }
    return [...seen.values()];
  }

  function removeDetails(c, storeId) {
    const details = inStore({ url: cookieUrl(c), name: c.name }, storeId);
    if (c.partitionKey) details.partitionKey = { ...c.partitionKey };
    return details;
  }

  /**
   * Remove every Zoho cookie of the regular store (or `storeId`).
   * chrome.cookies.remove({url, name}) deletes every same-name cookie sent to
   * that URL, and pages may set cookies while we work, so re-snapshot and
   * repeat until nothing is left (max 3 passes).
   * Returns the number of distinct cookies removed (survivors not counted).
   */
  async function clear({ storeId } = {}) {
    const a = cookiesApi();
    const removed = new Map();
    let live = await snapshot({ storeId });
    for (let pass = 0; pass < MAX_CLEAR_PASSES && live.length > 0; pass += 1) {
      for (const c of live) removed.set(cookieKey(c), c);
      await Promise.allSettled(live.map((c) => attempt(() => a.remove(removeDetails(c, storeId)))));
      live = await snapshot({ storeId });
    }
    for (const c of live) removed.delete(cookieKey(c));
    return removed.size;
  }

  /** Sets one cookie; resolves to null on success or an error message. */
  async function setOne(c) {
    try {
      const result = await cookiesApi().set(toSetDetails(c));
      return result == null ? 'Cookie was not set' : null;
    } catch (err) {
      return errorMessage(err);
    }
  }

  /**
   * Set saved cookies back into the regular store (never another one): all in
   * parallel, then each failure retried once,
   * one at a time. Expired persistent cookies are skipped; with `onlyMissing`
   * so are cookies already live (same name|domain|path|partitionKey), so newer
   * live values are never overwritten. A set() that rejects, throws, or
   * resolves null/undefined twice is reported in `failed`.
   */
  async function restore(saved, { onlyMissing = false } = {}) {
    cookiesApi(); // fail fast without chrome.cookies, even for an empty list
    const nowSeconds = now() / 1000;
    const live = onlyMissing ? new Set((await snapshot()).map(cookieKey)) : null;
    const toSet = [];
    let skipped = 0;
    for (const c of saved ?? []) {
      const expired = !c.session && typeof c.expirationDate === 'number' && c.expirationDate <= nowSeconds;
      if (expired || live?.has(cookieKey(c))) {
        skipped += 1;
      } else {
        toSet.push(c);
      }
    }

    const firstErrors = await Promise.all(toSet.map(setOne));
    const failed = [];
    for (const c of toSet.filter((_, i) => firstErrors[i] !== null)) {
      const error = await setOne(c);
      if (error !== null) failed.push({ name: c.name, domain: c.domain, error });
    }
    return { restored: toSet.length - failed.length, skipped, failed };
  }

  return { snapshot, clear, restore };
}
