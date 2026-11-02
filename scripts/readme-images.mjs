// Dev-only: renders the README screenshots of the real popup into docs/images/.
//
//   node scripts/readme-images.mjs [shot ...]
//
// Drives the popup harness (test/popup-harness: the real popup.html against a
// stubbed background) in Playwright's bundled headless Chromium at device scale
// factor 2, light and dark, and writes docs/images/<shot>-<theme>.png. Each image
// is cropped to the popup and framed like a browser popup (rounded corners,
// hairline border) on a transparent background, so it sits well on GitHub's light
// and dark themes. A full run also copies the 128 px icon to docs/images/icon-128.png.
//
// If ImageMagick (`magick`) is installed, each PNG is reduced to a 256-colour
// palette (about a third of the size). That's why there's no soft drop shadow:
// its gradient would band.
//
// The browser gets its own throwaway --user-data-dir, never a running Chrome or
// your profile.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startServer } from '../test/popup-harness/serve.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs/images');
const SCALE = 2;
const MARGIN = { top: 4, right: 4, bottom: 6, left: 4 }; // CSS px around the popup: room for the frame
const NEW_ACCOUNT = 'Client: Globex';

const tid = (testid, id) => `${id ? `[data-id="${id}"] ` : ''}[data-testid="${testid}"]`;

/** Waits until the popup has rendered and no request is in flight. */
async function settled(page) {
  await page.waitForSelector('body[data-busy="false"]');
  await page.waitForTimeout(150); // let focus rings / transitions finish
}

async function savePrivate(page) {
  await page.fill(tid('new-account-name'), NEW_ACCOUNT);
  await page.click(tid('finish-add'));
  await page.waitForSelector('[data-testid="message"]:not(:empty)');
  await settled(page);
}

// name → { scenario, prepare(page) }. `scenario` is the harness query string.
const SHOTS = {
  // Hero: several accounts, one active.
  list: { scenario: 'list' },
  // Walkthrough 1: private-window add in progress, a name typed in.
  'private-pending': {
    scenario: 'private-pending',
    async prepare(page) {
      await page.fill(tid('new-account-name'), NEW_ACCOUNT);
      await page.locator(tid('new-account-name')).blur();
    },
  },
  // Walkthrough 2: saved from the private window, "Click it to switch".
  'private-saved': { scenario: 'private-pending', prepare: savePrivate },
  // Walkthrough 3: switched to the new account.
  switched: {
    scenario: 'private-pending',
    async prepare(page) {
      await savePrivate(page);
      await page.click(`[data-testid="account"]:has-text("${NEW_ACCOUNT}") [data-testid="switch"]`);
      await page.waitForSelector(`[data-testid="account"][data-active="true"]:has-text("${NEW_ACCOUNT}")`);
      await settled(page);
      await page.evaluate(() => document.activeElement?.blur());
    },
  },
  // An unsaved session is live: confirm before switching away from it.
  'confirm-switch': {
    scenario: 'no-active',
    async prepare(page) {
      await page.click(tid('switch', 'a2'));
      await page.waitForSelector(tid('confirm-switch', 'a2'));
    },
  },
  // Extension not allowed in Incognito: hint under "+ Add account".
  'incognito-hint': { scenario: 'incognito-off' },
};

// Transparent page around the popup: the root needs a (see-through) background
// image, or <body>'s background propagates to the canvas, and no color-scheme, or
// the canvas gets the scheme's opaque color. The popup keeps its scheme via <body>.
const PAGE_CSS = `
  html { color-scheme: normal !important; background: linear-gradient(transparent, transparent) !important;
    padding: ${MARGIN.top}px ${MARGIN.right}px ${MARGIN.bottom}px ${MARGIN.left}px; }
  body { color-scheme: light dark; border-radius: 12px; overflow: hidden; }`;
const FRAME_CSS = {
  light: `${PAGE_CSS}
    body {
      box-shadow: 0 0 0 1px rgba(15, 23, 42, .14), 0 1px 3px rgba(15, 23, 42, .10); }`,
  dark: `${PAGE_CSS}
    body {
      box-shadow: 0 0 0 1px rgba(255, 255, 255, .14), 0 1px 3px rgba(0, 0, 0, .25); }`,
};

async function shoot(context, base, name, theme) {
  const { scenario, prepare } = SHOTS[name];
  const page = await context.newPage();
  try {
    await page.emulateMedia({ colorScheme: theme });
    await page.goto(`${base}/extension/popup/popup.html?scenario=${scenario}&delay=60`);
    await settled(page);
    await prepare?.(page);
    await page.mouse.move(0, 0); // no hover highlight where the last click landed
    await page.addStyleTag({ content: FRAME_CSS[theme] });
    await page.waitForTimeout(100);
    const box = await page.locator('body').boundingBox();
    const out = path.join(OUT, `${name}-${theme}.png`);
    await page.screenshot({
      path: out,
      omitBackground: true,
      clip: {
        x: box.x - MARGIN.left,
        y: box.y - MARGIN.top,
        width: Math.ceil(box.width) + MARGIN.left + MARGIN.right,
        height: Math.ceil(box.height) + MARGIN.top + MARGIN.bottom,
      },
    });
    return out;
  } finally {
    await page.close();
  }
}

/** 256-colour palette PNG without dithering: visually identical for flat UI. */
function optimise(file) {
  try {
    execFileSync('magick', [file, '-strip', '+dither', '-colors', '256',
      '-define', 'png:compression-level=9', file], { stdio: 'ignore' });
  } catch {
    // ImageMagick not installed: keep Chromium's PNG.
  }
}

const wanted = process.argv.slice(2);
for (const name of wanted) {
  if (!SHOTS[name]) throw new Error(`Unknown shot "${name}" (have: ${Object.keys(SHOTS).join(', ')})`);
}
await fs.mkdir(OUT, { recursive: true });
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'readme-images-chromium-'));
const server = await startServer(0);
const base = `http://127.0.0.1:${server.address().port}`;
const context = await chromium.launchPersistentContext(profile, {
  headless: true,
  viewport: { width: 320 + MARGIN.left + MARGIN.right, height: 900 },
  deviceScaleFactor: SCALE,
  args: ['--no-first-run', '--no-default-browser-check', '--disable-extensions', '--hide-scrollbars'],
});
try {
  for (const name of wanted.length ? wanted : Object.keys(SHOTS)) {
    for (const theme of ['light', 'dark']) {
      const out = await shoot(context, base, name, theme);
      optimise(out);
      console.log(path.relative(process.cwd(), out));
    }
  }
  if (!wanted.length) {
    const icon = path.join(OUT, 'icon-128.png');
    await fs.copyFile(path.join(ROOT, 'extension/icons/icon-128.png'), icon);
    console.log(path.relative(process.cwd(), icon));
  }
} finally {
  await context.close();
  server.close();
  await fs.rm(profile, { recursive: true, force: true });
}
