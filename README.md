# Zoho Account Switcher

A Chrome extension that keeps several Zoho accounts in one Chrome profile and
switches between them in a click — no re-typing passwords or OTPs.

It works by saving a copy of every Zoho cookie for each account. Switching saves
the current account's cookies, swaps in the target account's, and reloads every
open Zoho tab. All Zoho tabs follow the active account (one account at a time).

Covers every Zoho data center: `zoho.com`, `.in`, `.eu`, `.com.au`, `.jp`,
`.com.cn`, `.sa`, `.uk`, `zohocloud.ca`.

## Install (unpacked)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the `extension/` folder of this repo.

The manifest has a fixed key, so the extension id is always
`cdejiijaefadneogcpfoadhdenpfgano` — your saved accounts survive moving or
re-cloning the folder. After pulling changes, click the reload icon on the
extension's card.

## Use

Open the popup from the toolbar (pin it) or press **Alt+Shift+Z**.

- **Already signed in?** On first run the popup offers *Save this session as…* —
  name it and you're done.
- **Add account** → the extension signs the browser out of Zoho (your other
  saved accounts are kept) and opens the Zoho sign-in page. Sign in however you
  normally do, then name the account in the popup and **Save**. **Cancel** puts
  you back on the previous account.
- **Switch** → click an account. Every open Zoho tab reloads as that account.
  The toolbar badge shows the active account's initials and color.
- **⋯ menu** → rename or remove an account. Removing only deletes the saved copy;
  it doesn't sign anything out.
- **Deep clean site data on switch** → also wipes Zoho's local storage, IndexedDB,
  caches and service workers on each switch. Leave it off unless an app shows
  stale data from the previous account after switching.

### Things to know

- **Don't use Zoho's own "Sign out"** for an account you want to keep — that ends
  the session on Zoho's servers and you'll have to sign in again. Just switch.
- If Zoho expires a session (or your org enforces a timeout), switching to that
  account lands on the sign-in page. Sign in again; the extension picks up the
  new session automatically.
- The **Zoho Vault browser extension** keeps its own login and is not affected;
  only the Vault web app follows the switch.
- Saved sessions are stored **unencrypted** in the extension's local storage in
  your Chrome profile. Anyone who can read your profile folder could use them.

## Develop

No build step — plain ES modules.

```sh
npm test            # unit tests (node:test)
npm install         # once, for the E2E suite (Playwright)
npx playwright install chromium
npm run test:e2e    # end-to-end against a fake Zoho server in headless Chromium
```

- `extension/lib/` — `zoho-domains`, `cookie-jar` (snapshot/clear/restore),
  `accounts` (storage), `switcher` (serialized operations), `site-data` (tab
  reload, deep clean), `badge`, `router` (popup messages + debounced sync).
- `test/popup-harness/` — renders the popup against canned states for visual
  checks (`node test/popup-harness/serve.mjs`).
- Design: `docs/superpowers/specs/2026-11-02-zoho-account-switcher-design.md`.
