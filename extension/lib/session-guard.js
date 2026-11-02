// Decides whether the live Zoho cookie jar looks signed out compared with an
// account's saved copy, so a snapshot never replaces a working saved session
// with an emptied ("Clear browsing data", cleaner extensions) or half-restored jar.
// Pure module: no `chrome` access.

import { ZOHO_DOMAINS } from './zoho-domains.js';

const ANCHOR_DOMAINS = new Set(ZOHO_DOMAINS.map((d) => `.${d}`));

/**
 * Zoho's IAM sign-in cookies are httpOnly domain cookies on the bare
 * data-center domain (e.g. `.zoho.com`); call those "anchors".
 */
export function isAnchorCookie(c) {
  return Boolean(c) && c.httpOnly === true && !c.hostOnly && ANCHOR_DOMAINS.has(c.domain);
}

const nameAndDomain = (c) => `${c.name}|${c.domain}`;

/**
 * Why `live` looks signed out relative to `saved` (a short phrase), or null if
 * it does not. Signed out = nothing live while something is saved, or none of
 * the saved anchor cookies (same name + domain) is live. A saved copy without
 * anchors only gets the first check.
 */
export function signOutReason(saved, live) {
  const savedList = Array.isArray(saved) ? saved : [];
  const liveList = Array.isArray(live) ? live : [];
  if (savedList.length === 0) return null;
  if (liveList.length === 0) return 'no Zoho cookies are set';
  const anchors = savedList.filter(isAnchorCookie);
  if (anchors.length === 0) return null;
  const liveKeys = new Set(liveList.map(nameAndDomain));
  if (anchors.some((c) => liveKeys.has(nameAndDomain(c)))) return null;
  const missing = [...new Set(anchors.map((c) => `${c.name} (${c.domain})`))];
  return `sign-in cookies missing: ${missing.join(', ')}`;
}

/** True if saving `live` over `saved` would replace a session with a signed-out jar. */
export function looksSignedOut(saved, live) {
  return signOutReason(saved, live) !== null;
}
