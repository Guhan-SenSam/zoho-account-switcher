#!/usr/bin/env node
// Records docs/images/demo.gif: the real extension switching Zoho accounts.
//
//   node scripts/record-demo.mjs [--out docs/images/demo.gif] [--fps 15] [--work-dir DIR]
//
// Reuses the E2E harness (test/e2e/helpers.js): Playwright's bundled Chromium with
// a temp profile and the unpacked extension, *.zoho.com mapped to the local fake
// Zoho server (here in its "pretty" webmail mode). Three accounts are added
// through the real beginAdd -> sign-in -> finishAdd flow. Then the popup page
// (chrome-extension://<id>/popup/popup.html) is clicked like a user would while
// it and a mail.zoho.com tab are captured. Both tabs use 200% browser zoom, so
// captures are 2x (like a HiDPI screen) without device-metrics emulation, which
// would skew mouse input while a screenshot is being taken. ffmpeg composites the
// two panes into a frame, downscales, and encodes a looping GIF.
//
// Needs `npm install`, `npx playwright install chromium`, ffmpeg and openssl.
// --work-dir keeps the intermediates (raw captures, sequences, stage images).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import {
  REPO, TMP, MAIL, launchBrowser, addAccount, readPage, waitForRerender, pollUntil, sleep, extensionPresent,
} from '../test/e2e/helpers.js';
import { startFakeZoho } from '../test/e2e/fake-zoho/server.js';
import { ACCOUNTS, PRETTY_USERS, installCursor, stageHtml } from './demo-assets.mjs';

const { values: opts } = parseArgs({
  options: {
    out: { type: 'string', default: path.join(REPO, 'docs', 'images', 'demo.gif') },
    fps: { type: 'string', default: '15' },
    'work-dir': { type: 'string' },
  },
});
const FPS = Number(opts.fps);
const OUT = path.resolve(opts.out);
const ZOOM = 2;

// Layout (CSS px). Panes: popup 320 x <its content height>, mail tab 760 x 460.
const POPUP_W = 320;
const MAIL_W = 760;
const MAIL_H = 460;
const PAD = 28;
const GAP = 22;
const TITLE = 30;
const RADIUS = 10;

// Timing.
const CAPTURE_TIMEOUT = 200; // ms; see startCapture()
const MAIL_DELAY = 650; // ms of server latency for mail pages: makes "Switching…" readable

const log = (...a) => console.log('[demo]', ...a);

function run(cmd, args) {
  return execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}

/** Wait until `page` renders at ZOOM (devicePixelRatio) with the given CSS viewport width. */
function waitZoomed(page, cssWidth) {
  return pollUntil(() => page.evaluate(([z, w]) => devicePixelRatio === z && innerWidth === w, [ZOOM, cssWidth]),
    { message: `page zoomed to ${ZOOM * 100}%` });
}

/**
 * Capture a page as fast as it renders: frames are { t (performance.now ms), data (base64 PNG) }.
 * A capture requested while a navigation commits can stay pending for good (and
 * the screen shows the previous frame meanwhile anyway), so each one times out.
 */
function startCapture(cdp) {
  const frames = [];
  let running = true;
  const loop = (async () => {
    while (running) {
      const t0 = performance.now();
      try {
        const { data } = await Promise.race([
          cdp.send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true }),
          sleep(CAPTURE_TIMEOUT).then(() => { throw new Error('capture timed out'); }),
        ]);
        frames.push({ t: (t0 + performance.now()) / 2, data });
      } catch {
        await sleep(5);
      }
    }
  })();
  return {
    frames,
    async stop() {
      running = false;
      await Promise.race([loop, sleep(3000)]);
    },
  };
}

async function screenshot(cdp) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  return Buffer.from(data, 'base64');
}

/** Latest frame captured at or before t (frames are in time order). */
function frameAt(frames, t) {
  let best = frames[0];
  for (const f of frames) {
    if (f.t > t) break;
    best = f;
  }
  return best;
}

async function record({ b, server, work }) {
  // --- Accounts, added through the real flow (sign-in tab -> finishAdd), Work first.
  const ids = [];
  for (const a of ACCOUNTS) {
    const { account } = await addAccount(b, { username: a.user, name: a.name });
    ids.push(account.id);
  }
  // "Allow in Incognito" on, as the README recommends (the popup then has no hint about it).
  await b.enableIncognito();
  await b.sendOk({ type: 'switch', id: ids[0] });
  await pollUntil(async () => !(await b.send({ type: 'getState' })).state.busy, { message: 'extension idle' });

  // --- The mail tab, zoomed per origin so the zoom survives the switch's reloads.
  const mail = await b.context.newPage();
  await mail.emulateMedia({ colorScheme: 'light' });
  await mail.setViewportSize({ width: MAIL_W * ZOOM, height: MAIL_H * ZOOM });
  await mail.goto(MAIL);
  await b.swEval(async (z) => {
    const tabs = await chrome.tabs.query({ url: 'https://mail.zoho.com/*' });
    if (tabs.length !== 1) throw new Error(`expected one mail tab, found ${tabs.length}`);
    await chrome.tabs.setZoom(tabs[0].id, z);
  }, ZOOM);
  await waitZoomed(mail, MAIL_W);
  const m0 = await readPage(mail);
  if (m0.who !== ACCOUNTS[0].user) throw new Error(`mail shows ${m0.who}, expected ${ACCOUNTS[0].user}`);

  // --- The popup, sized like Chrome sizes it: 320 px wide, as tall as its content.
  const popup = await b.context.newPage();
  await popup.addInitScript(() => { window.close = () => {}; });
  await popup.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
  await popup.setViewportSize({ width: POPUP_W * ZOOM, height: 600 * ZOOM });
  await popup.goto(`${b.extOrigin}popup/popup.html`);
  await popup.evaluate(async (z) => {
    const tab = await chrome.tabs.getCurrent();
    await chrome.tabs.setZoomSettings(tab.id, { scope: 'per-tab' });
    await chrome.tabs.setZoom(tab.id, z);
  }, ZOOM);
  await waitZoomed(popup, POPUP_W);
  await popup.waitForSelector('body[data-busy="false"]');
  const popH = Math.ceil(await popup.evaluate(() => document.body.getBoundingClientRect().height));
  await popup.setViewportSize({ width: POPUP_W * ZOOM, height: popH * ZOOM });

  // Mouse coordinates and bounding boxes are in the zoomed page's CSS px.
  const rowPoint = async (id) => {
    const box = await popup.locator(`[data-testid="account"][data-id="${id}"] [data-testid="switch"]`).boundingBox();
    return { x: Math.round(box.x + 160), y: Math.round(box.y + box.height * 0.5) }; // right of the name
  };
  const rest = { x: POPUP_W - 40, y: popH - 44 }; // right of the footer text, clear of the edge
  await popup.evaluate(installCursor, rest);
  await popup.mouse.move(rest.x, rest.y);
  await sleep(800); // let the mail rows' entrance animation finish

  // --- Record.
  const popCdp = await b.context.newCDPSession(popup);
  const mailCdp = await b.context.newCDPSession(mail);
  server.mailDelayMs = MAIL_DELAY;
  const capPopup = startCapture(popCdp);
  const capMail = startCapture(mailCdp);
  const tStart = performance.now();
  const marks = [];
  const mark = (what) => marks.push([what, Math.round(performance.now() - tStart)]);

  const switchTo = async (index, travelMs) => {
    const p = await rowPoint(ids[index]);
    await popup.evaluate(({ x, y, ms }) => window.__demoCursor.moveTo(x, y, ms), { ...p, ms: travelMs });
    await popup.mouse.move(p.x, p.y); // real hover
    await sleep(180);
    const before = await readPage(mail);
    await popup.evaluate(({ x, y }) => window.__demoCursor.press(x, y), p);
    mark(`click ${ACCOUNTS[index].name}`);
    await popup.mouse.down();
    await sleep(70);
    await popup.mouse.up();
    await popup.evaluate(() => window.__demoCursor.release());
    const after = await waitForRerender(mail, before.serial, { timeout: 15_000 });
    mark(`mail reloaded as ${after.who}`);
    if (after.who !== ACCOUNTS[index].user) throw new Error(`mail shows ${after.who}, expected ${ACCOUNTS[index].user}`);
    await popup.waitForSelector(`[data-testid="account"][data-id="${ids[index]}"][data-active="true"]`);
    await popup.waitForSelector('body[data-busy="false"]');
    await waitZoomed(mail, MAIL_W);
    log(`clicked ${ACCOUNTS[index].name}: mail tab reloaded as ${after.who}`);
  };

  // Work -> Personal -> Client – Acme -> Work, then the cursor goes back to where it
  // started: the last frame matches the first, so the GIF loops seamlessly.
  await sleep(1100);
  await switchTo(1, 750);
  await sleep(1700);
  await switchTo(2, 480);
  await sleep(1700);
  await switchTo(0, 560);
  await sleep(1200);
  await popup.evaluate(({ x, y }) => window.__demoCursor.moveTo(x, y, 650), rest);
  await popup.mouse.move(rest.x, rest.y);
  await sleep(450);

  const tEnd = performance.now();
  mark('end');
  await capPopup.stop();
  await capMail.stop();
  log(`captured ${capPopup.frames.length} popup + ${capMail.frames.length} mail frames in ${((tEnd - tStart) / 1000).toFixed(2)} s`);
  fs.writeFileSync(path.join(work, 'timeline.json'), JSON.stringify({
    marks,
    popup: capPopup.frames.map((f) => Math.round(f.t - tStart)),
    mail: capMail.frames.map((f) => Math.round(f.t - tStart)),
  }));

  // --- Stage artwork (background + pane mask) at the same 2x scale.
  const left = { x: PAD + 1, y: PAD + TITLE + 1, w: POPUP_W, h: popH };
  const right = { x: left.x + POPUP_W + 1 + GAP + 1, y: left.y, w: MAIL_W, h: MAIL_H };
  const g = { W: right.x + MAIL_W + 1 + PAD, H: right.y + MAIL_H + 1 + PAD, title: TITLE, radius: RADIUS, left, right };
  const icon = `data:image/png;base64,${fs.readFileSync(path.join(REPO, 'extension', 'icons', 'icon-32.png')).toString('base64')}`;
  const stage = await b.context.newPage();
  await stage.setViewportSize({ width: g.W * ZOOM, height: g.H * ZOOM });
  const stageCdp = await b.context.newCDPSession(stage);
  for (const mode of ['bg', 'mask']) {
    // about:blank can't be browser-zoomed; CSS zoom gives the same 2x rendering here.
    await stage.setContent(stageHtml(g, mode, icon).replace('<html>', `<html style="zoom:${ZOOM}">`));
    await stage.evaluate(() => document.fonts.ready);
    fs.writeFileSync(path.join(work, `${mode}.png`), await screenshot(stageCdp));
  }

  // --- Fixed-rate sequences: for each output frame, the latest capture of each pane.
  const n = Math.round(((tEnd - tStart) / 1000) * FPS);
  const files = new Map();
  for (let i = 0; i < n; i++) {
    const t = tStart + (i * 1000) / FPS;
    for (const [prefix, cap] of [['l', capPopup], ['r', capMail]]) {
      const f = frameAt(cap.frames, t);
      if (!files.has(f)) {
        const file = path.join(work, 'raw', `${prefix}-${String(files.size).padStart(5, '0')}.png`);
        fs.writeFileSync(file, Buffer.from(f.data, 'base64'));
        files.set(f, file);
      }
      const dest = path.join(work, 'seq', `${prefix}-${String(i).padStart(5, '0')}.png`);
      try { fs.linkSync(files.get(f), dest); } catch { fs.copyFileSync(files.get(f), dest); }
    }
  }
  return { g, n };
}

function encode({ g, n, work }) {
  const dur = n / FPS;
  const s = (v) => v * ZOOM;
  const filter = [
    // Panes onto a canvas, cut to the window shapes by the mask, over the background.
    `[0]pad=${s(g.W)}:${s(g.H)}:${s(g.left.x)}:${s(g.left.y)}:color=black[l]`,
    `[l][1]overlay=${s(g.right.x)}:${s(g.right.y)}:format=rgb[panes]`,
    `[3]format=gray[mask]`,
    `[panes][mask]alphamerge[cut]`,
    `[2][cut]overlay=0:0:format=rgb:shortest=1,scale=${g.W}:${g.H}:flags=lanczos,format=rgb24,split[v1][v2]`,
    `[v1]palettegen=max_colors=256:stats_mode=full[pal]`,
    `[v2][pal]paletteuse=dither=none:diff_mode=rectangle`,
  ].join(';');
  const seq = (p) => path.join(work, 'seq', `${p}-%05d.png`);
  const still = (file) => ['-loop', '1', '-framerate', String(FPS), '-t', dur.toFixed(4), '-i', path.join(work, file)];
  run('ffmpeg', [
    '-y', '-v', 'error',
    '-framerate', String(FPS), '-i', seq('l'),
    '-framerate', String(FPS), '-i', seq('r'),
    ...still('bg.png'),
    ...still('mask.png'),
    '-filter_complex', filter,
    '-loop', '0',
    OUT,
  ]);
}

async function main() {
  if (!extensionPresent()) throw new Error('extension/ is missing');
  run('ffmpeg', ['-version']);
  const work = opts['work-dir'] ? path.resolve(opts['work-dir']) : fs.mkdtempSync(path.join(os.tmpdir(), 'zas-demo-'));
  for (const d of ['raw', 'seq']) {
    fs.rmSync(path.join(work, d), { recursive: true, force: true });
    fs.mkdirSync(path.join(work, d), { recursive: true });
  }

  const server = await startFakeZoho({ certDir: path.join(TMP, 'cert'), pretty: { users: PRETTY_USERS } });
  let b = null;
  let closed = false;
  const shutdown = async () => {
    if (closed) return;
    closed = true;
    await b?.close().catch(() => {});
    await server.close().catch(() => {});
    if (b) fs.rmSync(b.userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  };
  // Never leave a headless Chromium or its temp profile behind if something hangs.
  const watchdog = setTimeout(async () => {
    console.error('[demo] timed out');
    await shutdown();
    process.exit(1);
  }, 240_000);
  watchdog.unref();

  let result;
  try {
    b = await launchBrowser({ port: server.port });
    log(`Chromium ${b.context.browser()?.version() ?? ''}, extension ${b.extensionId}, fake Zoho on :${server.port}`);
    result = await record({ b, server, work });
  } finally {
    await shutdown();
    clearTimeout(watchdog);
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  encode({ ...result, work });
  const probe = JSON.parse(run('ffprobe', ['-v', 'error', '-count_frames', '-show_entries',
    'stream=width,height,nb_read_frames:format=duration', '-of', 'json', OUT]));
  const st = probe.streams[0];
  log(`wrote ${OUT}: ${(fs.statSync(OUT).size / 1024 / 1024).toFixed(2)} MB, ${st.width}x${st.height}, ` +
    `${st.nb_read_frames} frames @ ${FPS} fps, ${Number(probe.format.duration).toFixed(2)} s`);
  if (opts['work-dir']) log(`intermediates kept in ${work}`);
  else fs.rmSync(work, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
