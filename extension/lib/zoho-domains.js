// Which hosts, URLs and cookie domains belong to Zoho.
// Pure module: no `chrome` access, importable from Node.

export const ZOHO_DOMAINS = Object.freeze([
  'zoho.com',
  'zoho.in',
  'zoho.eu',
  'zoho.com.au',
  'zoho.jp',
  'zoho.com.cn',
  'zoho.sa',
  'zoho.uk',
  'zohocloud.ca',
]);

// Chrome match patterns. `*://*.zoho.com/*` also matches the bare `zoho.com`.
export const ZOHO_HOST_PATTERNS = Object.freeze(ZOHO_DOMAINS.map((d) => `*://*.${d}/*`));

export const KNOWN_SUBDOMAINS = Object.freeze([
  'accounts', 'mail', 'mailadmin', 'admin', 'vault', 'workplace', 'crm', 'desk',
  'projects', 'cliq', 'calendar', 'workdrive', 'people', 'books', 'one', 'www',
]);

export const SIGN_IN_URL = 'https://accounts.zoho.com/signin';

/**
 * True if `hostname` is one of ZOHO_DOMAINS or a subdomain of one.
 * Matching is on whole labels, so `notzoho.com`, `zoho.com.evil.net` and
 * `zoho.community` are rejected. Malformed hosts (leading dot, empty labels,
 * trailing dot, port) are rejected too.
 */
export function isZohoHost(hostname) {
  if (typeof hostname !== 'string' || hostname === '') return false;
  const host = hostname.toLowerCase();
  if (host.startsWith('.') || host.endsWith('.') || host.includes('..')) return false;
  return ZOHO_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
}

/** True for http(s) URLs whose host is a Zoho host. False for anything unparsable. */
export function isZohoUrl(url) {
  if (typeof url !== 'string' && !(url instanceof URL)) return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  return isZohoHost(parsed.hostname);
}

/** True for a chrome.cookies Cookie.domain on a Zoho host (one leading '.' allowed). */
export function isZohoCookieDomain(domain) {
  if (typeof domain !== 'string') return false;
  return isZohoHost(domain.startsWith('.') ? domain.slice(1) : domain);
}
