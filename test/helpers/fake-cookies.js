// In-memory fake of chrome.cookies (promise API) for unit tests.
//
// Models the Chrome behaviour the cookie jar depends on (checked against the
// Chromium source, extensions/browser/api/cookies/ and net/cookies/):
//
// - getAll({domain}): cookies whose domain (leading '.' stripped) equals or is a
//   subdomain of `domain`. Without `partitionKey` only UNPARTITIONED cookies are
//   returned; `partitionKey: {}` (no topLevelSite) returns partitioned AND
//   unpartitioned cookies; `partitionKey: {topLevelSite}` returns only cookies
//   in that partition. Expired cookies are never returned.
// - set(details): host-only iff no `domain`; stored domain is '.'+domain for
//   domain cookies, else the URL host. session iff no expirationDate. Same
//   name+domain+path+partition overwrites. Cookies Chrome refuses (bad prefix,
//   SameSite=None without Secure, Secure over http, partitioned without Secure,
//   domain not matching the URL, public-suffix domain, relative path, or a
//   non-secure cookie from an http URL that would shadow an existing Secure
//   cookie — "Strict Secure Cookies": same name and partition, domains
//   domain-match either way, new path path-matches the Secure cookie's path)
//   make the promise REJECT with Chrome's message, like real Chrome. An already-expired
//   expirationDate deletes the existing cookie and resolves `undefined`, also
//   like Chrome. Pass `{ invalidSet: 'null' }` to resolve null instead of
//   rejecting.
// - remove({url, name}): deletes EVERY cookie with that name that would be sent
//   to `url` (domain-match, path-match, Secure needs https). Unpartitioned
//   cookies always qualify; partitioned ones only when `partitionKey` matches.
//   Resolves with the details whether or not anything was deleted.
// - Unknown properties in details throw synchronously, as Chrome's schema
//   validation does ("Unexpected property").
//
// Test helpers: dump() returns every live cookie, calls logs every call,
// latency (ms) delays each response (0 = next macrotask).

const SET_KEYS = new Set([
  'url', 'name', 'value', 'domain', 'path', 'secure', 'httpOnly', 'sameSite',
  'expirationDate', 'storeId', 'partitionKey',
]);
const GET_ALL_KEYS = new Set([
  'domain', 'name', 'partitionKey', 'path', 'secure', 'session', 'storeId', 'url',
]);
const REMOVE_KEYS = new Set(['url', 'name', 'storeId', 'partitionKey']);
const PARTITION_KEY_KEYS = new Set(['topLevelSite', 'hasCrossSiteAncestor']);
const SAME_SITE = new Set(['no_restriction', 'lax', 'strict', 'unspecified']);

// Tiny public-suffix list: enough to reject `domain: 'com'` style cookies.
const PUBLIC_SUFFIXES = new Set([
  'com', 'net', 'org', 'in', 'eu', 'jp', 'sa', 'uk', 'ca', 'cn', 'au',
  'com.au', 'com.cn', 'co.uk',
]);

function validateKeys(method, details, allowed) {
  if (details === null || typeof details !== 'object') {
    throw new TypeError(`Error in invocation of cookies.${method}: details must be an object`);
  }
  for (const key of Object.keys(details)) {
    if (!allowed.has(key)) {
      throw new TypeError(`Error in invocation of cookies.${method}: Unexpected property: '${key}'.`);
    }
  }
  if (details.partitionKey !== undefined) {
    for (const key of Object.keys(details.partitionKey)) {
      if (!PARTITION_KEY_KEYS.has(key)) {
        throw new TypeError(
          `Error in invocation of cookies.${method}: partitionKey: Unexpected property: '${key}'.`,
        );
      }
    }
  }
}

const stripDot = (d) => (d.startsWith('.') ? d.slice(1) : d);

function partitionId(pk) {
  if (!pk || !pk.topLevelSite) return '';
  return `${pk.topLevelSite}|${pk.hasCrossSiteAncestor === true}`;
}

const keyOf = (c) => `${c.name}|${c.domain}|${c.path}|${partitionId(c.partitionKey)}`;

// RFC 6265 5.1.3
function domainMatches(host, cookie) {
  if (cookie.hostOnly) return host === cookie.domain;
  const d = stripDot(cookie.domain);
  return host === d || host.endsWith(`.${d}`);
}

// RFC 6265 5.1.4
function pathMatches(requestPath, cookiePath) {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith('/') || requestPath[cookiePath.length] === '/';
}

// RFC 6265 5.1.4 default-path
function defaultPath(url) {
  const p = url.pathname;
  if (!p.startsWith('/')) return '/';
  const last = p.lastIndexOf('/');
  return last <= 0 ? '/' : p.slice(0, last);
}

const domainOrSubdomain = (a, b) => a === b || a.endsWith(`.${b}`);

// rfc6265bis "Strict Secure Cookies": an insecure source may not set a cookie
// that would overlay an existing Secure cookie of the same name.
function shadowsSecureCookie(jar, candidate) {
  const d = stripDot(candidate.domain);
  for (const c of jar.values()) {
    if (!c.secure || c.name !== candidate.name) continue;
    if (partitionId(c.partitionKey) !== partitionId(candidate.partitionKey)) continue;
    const cd = stripDot(c.domain);
    if (!domainOrSubdomain(d, cd) && !domainOrSubdomain(cd, d)) continue;
    if (pathMatches(candidate.path, c.path)) return true;
  }
  return false;
}

// Chrome's MatchFilter::MatchesDomain for getAll({domain})
function filterDomainMatches(filter, cookieDomain) {
  const f = stripDot(filter.toLowerCase());
  const d = stripDot(cookieDomain);
  return d === f || d.endsWith(`.${f}`);
}

function partitionFilterMatches(filterPk, cookie) {
  if (filterPk === undefined) return !cookie.partitionKey; // unpartitioned only
  if (!filterPk.topLevelSite) return true; // {} => everything
  if (!cookie.partitionKey) return false;
  if (cookie.partitionKey.topLevelSite !== filterPk.topLevelSite) return false;
  return filterPk.hasCrossSiteAncestor === undefined
    || cookie.partitionKey.hasCrossSiteAncestor === filterPk.hasCrossSiteAncestor;
}

export function createFakeCookies({
  now = () => Date.now(),
  latency = 0,
  invalidSet = 'reject',
} = {}) {
  /** @type {Map<string, object>} */
  const jar = new Map();
  const calls = { getAll: [], set: [], remove: [] };

  const respond = (fn) => new Promise((resolve, reject) => {
    setTimeout(() => {
      try {
        resolve(fn());
      } catch (err) {
        reject(err);
      }
    }, latency);
  });

  const isExpired = (c) => !c.session && c.expirationDate <= now() / 1000;

  function purgeExpired() {
    for (const [k, c] of jar) if (isExpired(c)) jar.delete(k);
  }

  function getAll(details = {}) {
    validateKeys('getAll', details, GET_ALL_KEYS);
    calls.getAll.push(structuredClone(details));
    return respond(() => {
      purgeExpired();
      let url = null;
      if (details.url !== undefined) url = new URL(details.url);
      const out = [];
      for (const c of jar.values()) {
        if (!partitionFilterMatches(details.partitionKey, c)) continue;
        if (details.domain !== undefined && !filterDomainMatches(details.domain, c.domain)) continue;
        if (details.name !== undefined && details.name !== c.name) continue;
        if (details.path !== undefined && details.path !== c.path) continue;
        if (details.secure !== undefined && details.secure !== c.secure) continue;
        if (details.session !== undefined && details.session !== c.session) continue;
        if (url && !(domainMatches(url.hostname, c) && pathMatches(url.pathname, c.path)
          && (!c.secure || url.protocol === 'https:'))) continue;
        out.push(structuredClone(c));
      }
      return out;
    });
  }

  function set(details) {
    validateKeys('set', details, SET_KEYS);
    calls.set.push(structuredClone(details));
    return respond(() => {
      const name = details.name ?? '';
      const fail = (why) => {
        if (invalidSet === 'null') return null;
        throw new Error(`Failed to parse or set cookie named "${name}".${why ? ` (${why})` : ''}`);
      };

      let url;
      try {
        url = new URL(details.url);
      } catch {
        throw new Error(`Invalid url: "${details.url}".`);
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return fail('scheme');
      const host = url.hostname;
      const secure = details.secure === true;
      const httpOnly = details.httpOnly === true;
      const sameSite = details.sameSite ?? 'unspecified';
      if (!SAME_SITE.has(sameSite)) {
        throw new TypeError(`Error in invocation of cookies.set: invalid sameSite '${sameSite}'.`);
      }

      let domain;
      let hostOnly;
      if (details.domain) {
        const d = stripDot(details.domain.toLowerCase());
        if (!d || PUBLIC_SUFFIXES.has(d)) return fail('public suffix domain');
        if (!(host === d || host.endsWith(`.${d}`))) return fail('domain does not match url');
        domain = `.${d}`;
        hostOnly = false;
      } else {
        domain = host;
        hostOnly = true;
      }

      if (details.path !== undefined && details.path !== '' && !details.path.startsWith('/')) {
        return fail('path');
      }
      const path = details.path ? details.path : defaultPath(url);

      if (secure && url.protocol !== 'https:') return fail('Secure cookie from insecure url');
      const lower = name.toLowerCase();
      if (lower.startsWith('__secure-') && !secure) return fail('__Secure- prefix');
      if (lower.startsWith('__host-') && (!secure || !hostOnly || path !== '/')) {
        return fail('__Host- prefix');
      }
      if (sameSite === 'no_restriction' && !secure) return fail('SameSite=None without Secure');

      let partitionKey;
      if (details.partitionKey?.topLevelSite) {
        if (!secure) return fail('Partitioned without Secure');
        partitionKey = {
          topLevelSite: details.partitionKey.topLevelSite,
          hasCrossSiteAncestor: details.partitionKey.hasCrossSiteAncestor === true,
        };
      }

      const session = details.expirationDate === undefined;
      const cookie = {
        domain,
        hostOnly,
        httpOnly,
        name,
        path,
        sameSite,
        secure,
        session,
        storeId: '0',
        value: details.value ?? '',
      };
      if (!session) cookie.expirationDate = details.expirationDate;
      if (partitionKey) cookie.partitionKey = partitionKey;

      if (!secure && url.protocol !== 'https:' && shadowsSecureCookie(jar, cookie)) {
        return fail('would overlay a Secure cookie from an insecure origin');
      }

      const key = keyOf(cookie);
      if (isExpired(cookie)) {
        // Chrome deletes the existing cookie and stores nothing; set() resolves undefined.
        jar.delete(key);
        return undefined;
      }
      jar.set(key, cookie);
      return structuredClone(cookie);
    });
  }

  function remove(details) {
    validateKeys('remove', details, REMOVE_KEYS);
    calls.remove.push(structuredClone(details));
    return respond(() => {
      const url = new URL(details.url);
      const filterPartition = partitionId(details.partitionKey);
      purgeExpired();
      for (const [k, c] of jar) {
        if (c.name !== details.name) continue;
        if (c.partitionKey && partitionId(c.partitionKey) !== filterPartition) continue;
        if (!domainMatches(url.hostname, c)) continue;
        if (!pathMatches(url.pathname, c.path)) continue;
        if (c.secure && url.protocol !== 'https:') continue;
        jar.delete(k);
      }
      const result = { name: details.name, storeId: '0', url: details.url };
      if (details.partitionKey) result.partitionKey = structuredClone(details.partitionKey);
      return result;
    });
  }

  return {
    getAll,
    set,
    remove,
    calls,
    /** Every live cookie (cloned), regardless of partition. */
    dump() {
      purgeExpired();
      return [...jar.values()].map((c) => structuredClone(c));
    },
  };
}
