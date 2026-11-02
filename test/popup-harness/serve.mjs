// Dev-only static server for the popup visual harness.
//
//   node test/popup-harness/serve.mjs [port]
//   → open http://127.0.0.1:<port>/test/popup-harness/index.html
//
// Serves extension/ and test/popup-harness/ from the repo. When the real
// extension/popup/popup.html is requested with ?scenario=..., stub.js is
// injected before popup.js so `chrome.runtime.sendMessage` hits a fake
// in-page background instead of the extension.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ALLOWED = ['extension/', 'test/popup-harness/'];
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};
const STUB_TAG = '<script src="/test/popup-harness/stub.js"></script>';
const SELFTEST_TAG = '<script src="/test/popup-harness/selftest.js"></script>';

export function startServer(port = 0) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      if (rel === '') rel = 'test/popup-harness/index.html';
      const file = path.resolve(ROOT, rel);
      if (!file.startsWith(ROOT + path.sep) || !ALLOWED.some((p) => rel.startsWith(p))) {
        res.writeHead(404).end('not found');
        return;
      }
      let body = await fs.readFile(file);
      if (rel === 'extension/popup/popup.html' && url.searchParams.has('scenario')) {
        // Classic scripts in <head> run before the deferred popup.js module.
        const tags = url.searchParams.has('selftest') ? `${STUB_TAG}\n  ${SELFTEST_TAG}` : STUB_TAG;
        body = Buffer.from(body.toString('utf8').replace('<link rel="stylesheet"', `${tags}\n  <link rel="stylesheet"`));
      }
      res.writeHead(200, {
        'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream',
        'cache-control': 'no-store',
      });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = await startServer(Number(process.argv[2] ?? 8765));
  const { port } = server.address();
  console.log(`Popup harness: http://127.0.0.1:${port}/test/popup-harness/index.html`);
}
