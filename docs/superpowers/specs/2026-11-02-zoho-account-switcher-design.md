# Zoho Account Switcher — Design

Date: 2026-11-02 · Status: approved (user delegated remaining decisions)

## Goal

A Chrome (MV3) extension that lets one Chrome profile hold several Zoho accounts
and switch between them in about a second, without re-entering passwords/OTP.

Usage pattern (from the user): **one account at a time, fast switching**. All
open Zoho tabs follow the active account. Per-tab isolation was considered and
rejected (Zoho Mail's service workers / websockets / background polling defeat
per-tab cookie rewriting).

Apps in use: Zoho Mail / Workplace, Mail admin + admin console, Vault, CRM / Desk / Projects.

## Approach: global cookie-jar swap

Each saved account = a snapshot of every cookie on every Zoho domain. Switching:

1. Snapshot the live Zoho cookies into the outgoing account (captures rotation).
2. Remove all Zoho cookies.
3. (Optional "deep clean") wipe Zoho origins' localStorage / IndexedDB / caches / service workers.
4. Restore the target account's cookies.
5. Mark target active, update badge.
6. In every open Zoho tab: clear `sessionStorage`, then reload.

While an account is active, any Zoho cookie change re-snapshots it (debounced
1500 ms), so the saved copy never goes stale.

### Decisions

- **Storage:** plain `chrome.storage.local` (user chose no passphrase). Saved
  cookies are live sessions; README must say so.
- **Data centers:** all of `zoho.com, zoho.in, zoho.eu, zoho.com.au, zoho.jp,
  zoho.com.cn, zoho.sa, zoho.uk, zohocloud.ca`.
- **Sign-in URL** for "Add account": `https://accounts.zoho.com/signin` (Zoho
  redirects to the right DC).
- **Deep clean** defaults to **off**.
- **Removing** an account only deletes the saved snapshot; it never touches live
  cookies (removing the active account leaves the browser signed in and
  `activeId = null`).
- **Browser restart:** on `runtime.onStartup`, re-apply the active account's saved
  cookies (without clearing first) so session cookies survive restarts.
- Users must not click Zoho's own "Sign out" for accounts they want to keep
  (it kills the server-side session). README says so.
- No build step. Plain ES modules. No runtime dependencies.

## File layout and ownership

```
extension/
  manifest.json            (orchestration)
  background.js            (orchestration) service worker, type: module
  lib/zoho-domains.js      (core)
  lib/cookie-jar.js        (core)
  lib/accounts.js          (core)
  lib/switcher.js          (orchestration)
  lib/site-data.js         (orchestration)
  lib/badge.js             (orchestration)
  popup/popup.html|css|js  (popup)
  icons/icon-16.png, icon-32.png, icon-48.png, icon-128.png  (popup)
test/
  unit/*.test.js           node:test, run with `npm test`
  e2e/                     Playwright + fake Zoho server, run with `npm run test:e2e`
```

All `extension/` modules must be importable from Node (no `chrome` access at
import time — default parameters read `globalThis.chrome` lazily) so they can be
unit tested with fakes. Root `package.json` has `"type": "module"`.

## Module contracts

### `lib/zoho-domains.js`

```js
export const ZOHO_DOMAINS        // ['zoho.com','zoho.in','zoho.eu','zoho.com.au','zoho.jp','zoho.com.cn','zoho.sa','zoho.uk','zohocloud.ca']
export const ZOHO_HOST_PATTERNS  // ZOHO_DOMAINS.map(d => `*://*.${d}/*`)  (matches the bare domain too)
export const KNOWN_SUBDOMAINS    // ['accounts','mail','mailadmin','admin','vault','workplace','crm','desk','projects','cliq','calendar','workdrive','people','books','one','www']
export const SIGN_IN_URL         // 'https://accounts.zoho.com/signin'
export function isZohoHost(hostname)        // true if hostname === d or endsWith('.'+d) for some d; case-insensitive
export function isZohoUrl(url)              // http(s) only; false for unparsable
export function isZohoCookieDomain(domain)  // cookie.domain, leading '.' allowed
```
Beware suffix traps: `notzoho.com`, `zoho.com.evil.net`, `zoho.community` are NOT Zoho.

### `lib/cookie-jar.js`

`SavedCookie` = plain object: `{ name, value, domain, hostOnly, path, secure,
httpOnly, sameSite, session, expirationDate?, partitionKey? }` (no `storeId`;
`expirationDate` only when `!session`; `partitionKey` only when present).

```js
export function toSavedCookie(chromeCookie)   // -> SavedCookie
export function cookieUrl(cookie)             // `${secure?'https':'http'}://${domain without leading '.'}${path||'/'}`
export function toSetDetails(saved)           // -> chrome.cookies.set() details:
   // url=cookieUrl, name, value, path, secure, httpOnly, sameSite;
   // domain ONLY when !hostOnly (required for __Host- cookies and host-only semantics);
   // expirationDate ONLY when !session; partitionKey when present.
export function createCookieJar(api = globalThis.chrome?.cookies, { now = () => Date.now() } = {}) → {
  snapshot(): Promise<SavedCookie[]>
     // for each ZOHO_DOMAINS d: api.getAll({domain: d}); also try api.getAll({domain: d, partitionKey: {}})
     // to include partitioned cookies (ignore errors from that call); dedupe on
     // name|domain|path|JSON(partitionKey ?? null); keep only isZohoCookieDomain.
  clear(): Promise<number>
     // snapshot, then api.remove({url: cookieUrl(c), name, partitionKey?}) for each; returns count removed.
  restore(saved: SavedCookie[]): Promise<{ restored: number, skipped: number, failed: {name, domain, error}[] }>
     // skip non-session cookies with expirationDate <= now()/1000; api.set(toSetDetails(c)) for the rest,
     // in parallel (allSettled); a set() resolving to null counts as failed.
}
```
Verify the `partitionKey: {}` semantics of `chrome.cookies.getAll` against the
current Chrome docs and adapt if needed.

### `lib/accounts.js`

Storage keys in `chrome.storage.local`:
```
accounts: { [id]: Account }   Account = { id, name, color, cookies: SavedCookie[], createdAt, savedAt }
order:    string[]            display order
activeId: string | null
settings: { deepClean: boolean }   default { deepClean: false }
pending:  null | { previousId: string|null, startedAt: number }   "add account" in progress
```
```js
export const COLORS                 // 8 distinct hex colors, readable with white text
export function initials(name)      // 'TurfScout Ops' -> 'TO', 'personal' -> 'PE', 'x' -> 'X'; max 2 chars, uppercase
export function createAccountStore(storage = globalThis.chrome?.storage?.local) → {
  getState()                 // { accounts, order, activeId, settings, pending } with defaults filled
  list()                     // AccountSummary[] in order: { id, name, color, initials, createdAt, savedAt, cookieCount }
  get(id)                    // Account | null
  create({ name, cookies })  // new Account (id = crypto.randomUUID(), color = first COLORS entry not in use, else cycle); appended to order
  updateCookies(id, cookies) // sets cookies + savedAt; no-op if id unknown
  rename(id, name)
  remove(id)                 // deletes, removes from order, clears activeId if it was active
  getActiveId(); setActiveId(idOrNull)
  getSettings(); updateSettings(patch)   // returns merged settings
  getPending(); setPending(pendingOrNull)
}
```
Names: trimmed, 1–40 chars, otherwise throw `Error('Name must be 1–40 characters')`.
Mutations are serialized internally (promise-chain mutex) so read-modify-write never interleaves.

### `lib/site-data.js`

```js
export function createSiteData({ tabs, scripting, browsingData } = globalThis.chrome ?? {}) → {
  listZohoTabs()            // tabs.query({ url: ZOHO_HOST_PATTERNS })
  resetTabs()               // for each Zoho tab: scripting.executeScript({target:{tabId}, func: () => sessionStorage.clear()})
                            // (errors ignored, e.g. discarded/crashed tabs), then tabs.reload(tabId). Returns count.
  deepClean()               // browsingData.remove({ origins }, { localStorage, indexedDB, cacheStorage, serviceWorkers, fileSystems: true })
                            // origins = https://{sub}.{d} for KNOWN_SUBDOMAINS × ZOHO_DOMAINS, https://{d},
                            // plus origins of currently open Zoho tabs (deduped).
  openSignIn()              // tabs.create({ url: SIGN_IN_URL, active: true })
}
```

### `lib/badge.js`

```js
export function createBadge(action = globalThis.chrome?.action) → {
  show({ active /* AccountSummary|null */, pending /* bool */ })
    // pending: text '+', grey; active: text initials, bg = account color, title 'Zoho: <name>';
    // none: text '', title 'Zoho Account Switcher'
}
```

### `lib/switcher.js`

```js
export function createSwitcher({ jar, store, siteData, badge }) → {
  isBusy()                   // true while a user-initiated op (switch/add/finish/cancel/saveCurrent/remove) runs
  switchTo(id)               // -> { warnings: string[] }   (see "Approach" steps; no-op if id already active)
  beginAdd()                 // snapshot active into its slot; pending = {previousId: activeId, startedAt}; activeId = null;
                             // clear cookies; deepClean if enabled; resetTabs; openSignIn. Idempotent if already pending (just reopens sign-in).
  finishAdd(name)            // requires pending; snapshot -> store.create; set active; pending = null. -> Account
  cancelAdd()                // requires pending; clear; restore previous account (if still exists) & set it active; pending = null;
                             // deepClean if enabled; resetTabs
  saveCurrentAs(name)        // requires !pending && activeId === null; snapshot -> create -> set active. -> Account
  remove(id)                 // store.remove(id) only (never touches live cookies)
  syncActive()               // -> boolean. Skip (false) if any op is running/queued, pending, or no activeId.
                             // Otherwise snapshot -> store.updateCookies(activeId) under the mutex.
  restoreActiveOnStartup()   // if activeId && !pending: jar.restore(active.cookies) without clearing
  refreshBadge()
}
```
All operations go through one internal mutex so they never interleave. Errors
are thrown as `Error` with user-readable messages (e.g. `'Finish or cancel
adding an account first'`, `'Unknown account'`). Every op that changes
active/pending calls `refreshBadge()`.

### `background.js`

- Builds `jar`, `store`, `siteData`, `badge`, `switcher` with real `chrome.*`.
- `runtime.onStartup` → `restoreActiveOnStartup()`; `onInstalled` and SW start → `refreshBadge()`.
- `cookies.onChanged`: if `isZohoCookieDomain(cookie.domain)` → debounce 1500 ms → `syncActive()`.
- `runtime.onMessage` router; only accept senders whose `sender.url` starts with
  `chrome.runtime.getURL('')`. Always `return true` and respond asynchronously.

## Message protocol (popup → background)

Request `{ type, ...args }`. Response `{ ok: true, state, ...extra }` or `{ ok: false, error, state }`.

| type            | args          | extra                  |
|-----------------|---------------|------------------------|
| `getState`      | —             | —                      |
| `switch`        | `{ id }`      | `{ warnings: string[] }` |
| `beginAdd`      | —             | —                      |
| `finishAdd`     | `{ name }`    | —                      |
| `cancelAdd`     | —             | —                      |
| `saveCurrentAs` | `{ name }`    | —                      |
| `rename`        | `{ id, name }`| —                      |
| `remove`        | `{ id }`      | —                      |
| `setSettings`   | `{ patch }`   | —                      |

`state` = `{ accounts: AccountSummary[], activeId, pending, settings, busy }`.

## Popup UI

~320 px wide, light + dark (`prefers-color-scheme`), no frameworks, no inline
scripts (MV3 CSP), user text via `textContent` only. No `alert/confirm/prompt`
(they don't work in popups) — use inline confirmation.

Views:
- **Pending add:** instructions ("Sign in to Zoho in the tab that just opened, then name this account"), name input, Save, Cancel.
- **Normal:** account list (color circle with initials, name, "Active" pill on the active one; clicking a non-active row switches). Each row has a ⋯ menu → Rename (inline input, Enter saves, Esc cancels) and Remove (inline "Confirm remove?" step).
- **No active account and not pending:** banner "Already signed in to Zoho? Save this session as:" + name input + Save.
- Footer: "+ Add account" button; "Deep clean site data on switch" checkbox with one-line hint.
- Busy: disable controls, show a small spinner. Errors/warnings: one inline message area.

Required `data-testid`s (used by E2E):
`account` (each `li`, with `data-id` and `data-active="true|false"`), `switch`
(the row's main button), `menu`, `rename`, `rename-input`, `remove`,
`confirm-remove`, `add-account`, `pending-panel`, `new-account-name`,
`finish-add`, `cancel-add`, `save-current-panel`, `save-current-name`,
`save-current`, `deep-clean`, `message`. `<body data-busy="true|false">`.

## Manifest

MV3; name "Zoho Account Switcher"; permissions `cookies, storage, scripting,
browsingData`; `host_permissions` = `ZOHO_HOST_PATTERNS`; background module
service worker; action popup `popup/popup.html` with icons; command
`_execute_action` suggested `Alt+Shift+Z`.

## Testing

- **Unit** (`node --test`): domains (suffix traps), cookie conversion (host-only,
  `__Host-`, session vs persistent, sameSite, partitioned, expired skip),
  account store (ordering, colors, validation, mutex), switcher (op ordering,
  pending rules, sync skip rules) with fakes.
- **E2E** (Playwright, bundled Chromium, headless): fake Zoho HTTPS server
  (self-signed cert; `--host-resolver-rules` maps `*.zoho.com` to it;
  `--ignore-certificate-errors`). It issues realistic cookies (domain + host-only,
  `__Host-`, session + persistent, path-scoped, rotating auth token that
  invalidates the old one). Scenarios: add two accounts, switch both ways with tabs
  reloading to the right user, rotation captured by sync, cancel-add restores,
  sessionStorage cleared on switch, deep clean wipes localStorage, remove, popup UI flow.
- **Manual:** user verifies on real Zoho accounts.
