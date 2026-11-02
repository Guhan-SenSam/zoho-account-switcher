// Dev-only: screenshots every harness scenario in light and dark with headless Chrome.
//
//   node test/popup-harness/screenshot.mjs [scenario-name ...]
//
// Writes test/popup-harness/screenshots/<name>-<theme>.png. Every Chrome launch
// gets its own throwaway --user-data-dir so it can never attach to (or open a
// window in) a Chrome the developer already has running.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './serve.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'screenshots');
const CHROME = process.env.CHROME_BIN || 'google-chrome-stable';

// name → [query string, viewport height]
const SHOTS = {
  list: ['scenario=list', 360],
  menu: ['scenario=list&click=menu@a2', 400],
  rename: ['scenario=list&click=menu@a2,rename@a2', 360],
  confirm: ['scenario=list&click=menu@a3,remove@a3', 440],
  pending: ['scenario=pending', 400],
  'no-active': ['scenario=no-active', 480],
  empty: ['scenario=empty', 440],
  error: ['scenario=error', 400],
  warning: ['scenario=warning', 430],
  busy: ['scenario=busy', 360],
  switching: ['scenario=list&delay=100000&click=switch@a2', 360],
  many: ['scenario=many', 600],
};

const THEMES = {
  light: ['--blink-settings=preferredColorScheme=1'],
  dark: ['--force-dark-mode', '--blink-settings=preferredColorScheme=0'],
};

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}\n${err}`))));
  });
}

async function shoot(base, name, theme) {
  const [query, height] = SHOTS[name];
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'popup-harness-chrome-'));
  const out = path.join(OUT, `${name}-${theme}.png`);
  try {
    await run(CHROME, [
      '--headless=new',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--disable-extensions',
      '--hide-scrollbars',
      `--window-size=320,${height}`,
      '--virtual-time-budget=4000',
      ...THEMES[theme],
      `--screenshot=${out}`,
      `${base}/extension/popup/popup.html?${query}`,
    ]);
  } finally {
    await fs.rm(profile, { recursive: true, force: true });
  }
  return out;
}

const wanted = process.argv.slice(2);
const names = wanted.length ? wanted : Object.keys(SHOTS);
await fs.mkdir(OUT, { recursive: true });
const server = await startServer(0);
const base = `http://127.0.0.1:${server.address().port}`;
try {
  for (const name of names) {
    if (!SHOTS[name]) throw new Error(`Unknown shot "${name}" (have: ${Object.keys(SHOTS).join(', ')})`);
    for (const theme of Object.keys(THEMES)) {
      console.log(path.relative(process.cwd(), await shoot(base, name, theme)));
    }
  }
} finally {
  server.close();
}
