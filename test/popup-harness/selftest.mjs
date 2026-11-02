// Dev-only: runs selftest.js against the real popup in headless Chrome.
//   node test/popup-harness/selftest.mjs
// Uses a throwaway --user-data-dir so it never touches a running Chrome.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer } from './serve.mjs';

const CHROME = process.env.CHROME_BIN || 'google-chrome-stable';
const server = await startServer(0);
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'popup-harness-chrome-'));
try {
  const url = `http://127.0.0.1:${server.address().port}/extension/popup/popup.html?scenario=list&delay=30&selftest`;
  const dom = await new Promise((resolve, reject) => {
    const child = spawn(CHROME, [
      '--headless=new', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
      '--disable-gpu', '--disable-extensions', '--window-size=320,600',
      '--virtual-time-budget=20000', '--dump-dom', url,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', reject);
    child.on('exit', () => resolve(out));
  });
  const m = dom.match(/<pre id="selftest">([\s\S]*?)<\/pre>/);
  if (!m) {
    console.error('selftest output not found (did the page finish?)');
    process.exitCode = 1;
  } else {
    const text = m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    console.log(text);
    if (/^FAIL/m.test(text)) process.exitCode = 1;
  }
} finally {
  server.close();
  await fs.rm(profile, { recursive: true, force: true });
}
