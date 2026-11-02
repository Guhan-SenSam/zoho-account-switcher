// Dev-only: runs selftest.js against the real popup in headless Chrome, once per
// scenario that has a suite (see SUITES in selftest.js).
//   node test/popup-harness/selftest.mjs [scenario ...]
// Every Chrome launch uses its own throwaway --user-data-dir so it never touches
// a running Chrome.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer } from './serve.mjs';

const CHROME = process.env.CHROME_BIN || 'google-chrome-stable';
const SCENARIOS = ['list', 'pending', 'private-pending', 'private-closed-captured', 'private-closed', 'incognito-off'];

async function runScenario(base, scenario) {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'popup-harness-chrome-'));
  try {
    const url = `${base}/extension/popup/popup.html?scenario=${encodeURIComponent(scenario)}&delay=30&selftest`;
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
    if (!m) return [`FAIL [${scenario}] selftest output not found (did the page finish?)`];
    const text = m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    return text.split('\n').filter(Boolean).map((line) => line.replace(/^(PASS|FAIL) /, `$1 [${scenario}] `));
  } finally {
    await fs.rm(profile, { recursive: true, force: true });
  }
}

const wanted = process.argv.slice(2);
const server = await startServer(0);
const base = `http://127.0.0.1:${server.address().port}`;
try {
  let pass = 0;
  let fail = 0;
  for (const scenario of wanted.length ? wanted : SCENARIOS) {
    for (const line of await runScenario(base, scenario)) {
      console.log(line);
      if (line.startsWith('FAIL')) fail += 1;
      else if (line.startsWith('PASS')) pass += 1;
    }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail || !pass) process.exitCode = 1;
} finally {
  server.close();
}
