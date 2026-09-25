#!/usr/bin/env node
/**
 * Optional headless UI test — boots the real index.html + app.js in jsdom
 * against the fixture snapshot produced by tools/test-build.mjs and clicks
 * through every view (board, archived date, seasons, game detail, standings).
 *
 * The repo itself stays zero-dependency: this test simply skips when jsdom
 * isn't installed.
 *
 *   node tools/test-build.mjs   # produces .test-dist/data (run this first)
 *   npm i jsdom                 # optional, anywhere Node can resolve it
 *   node tools/test-ui.mjs
 */
import { readFileSync, existsSync, rmSync, mkdirSync, copyFileSync, cpSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DATA = path.join(ROOT, '.test-dist', 'data');
if (!existsSync(path.join(DATA, 'manifest.json'))) {
  console.log('SKIP  no fixture snapshot — run `node tools/test-build.mjs` first');
  process.exit(0);
}

let JSDOM;
try {
  ({ JSDOM } = await import('jsdom'));
} catch {
  console.log('SKIP  jsdom is not installed (optional dev dependency) — install with `npm i jsdom`');
  process.exit(0);
}

// Stage a throwaway copy of the site with the fixture data.
const SITE = path.join(ROOT, '.test-dist', 'site');
rmSync(SITE, { recursive: true, force: true });
mkdirSync(SITE, { recursive: true });
for (const f of ['index.html', 'app.js', 'styles.css']) copyFileSync(path.join(ROOT, f), path.join(SITE, f));
cpSync(DATA, path.join(SITE, 'data'), { recursive: true });

const PORT = 8899;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const server = createServer((req, res) => {
  const p = path.join(SITE, req.url.split('?')[0].replace(/^\/+/, '') || 'index.html');
  try {
    const body = readFileSync(p);
    res.writeHead(200, { 'Content-Type': types[path.extname(p)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404); res.end('nope');
  }
}).listen(PORT, '127.0.0.1');
await new Promise((r) => server.once('listening', r));

const dom = new JSDOM(readFileSync(path.join(SITE, 'index.html'), 'utf8'), {
  url: `http://127.0.0.1:${PORT}/`,
  runScripts: 'outside-only',
  pretendToBeVisual: true,
});
const { window } = dom;
// jsdom has no fetch — hand the app Node's fetch, scoped to the local server.
window.fetch = (url, opts) => fetch(new URL(url, `http://127.0.0.1:${PORT}/`), opts);
window.eval(readFileSync(path.join(SITE, 'app.js'), 'utf8'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (sel) => window.document.querySelector(sel)?.textContent || '';
let failed = 0;
const check = (cond, label) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`); if (!cond) failed += 1; };

await sleep(1500);
check(window.document.querySelectorAll('#board-content .game-card').length >= 1, 'board renders game cards');
check(text('#data-status').length > 0, 'status bar shows a data source');

window.location.hash = '#/board/2026-09-19';
await sleep(1200);
check(window.document.querySelectorAll('#board-content .game-card').length === 1, 'archived date renders from the archive snapshot');
check(text('#board-content').includes('BOS') && text('#board-content').includes('BUF'), 'archived game teams shown');

window.location.hash = '#/season/BUF/20262027';
await sleep(1500);
check(window.document.querySelectorAll('.season-row').length === 5, 'season view renders all fixture games');
check(/PTS/.test(text('#seasons-content')), 'record strip renders points');
check(text('#seasons-content').includes('club-schedule-season/BUF/20262027'), 'season view shows the official source link');
const chips = [...window.document.querySelectorAll('.result-chip')].map((c) => c.textContent);
check(chips.includes('W') && chips.includes('T'), `result chips include W and T (got ${chips.join(',')})`);

window.location.hash = '#/game/1/2026-09-19';
await sleep(1500);
check(text('#game-content').includes('Scoring summary'), 'game detail shows the official scoring summary');
check(text('#game-content').includes('Faulk'), 'scoring summary lists the official goal scorer');
check(text('#game-content').includes('official NHL.com Game Center'), 'missing pbp/box notice links the official Game Center');

window.location.hash = '#/standings';
await sleep(1200);
check(window.document.querySelectorAll('#standings-content table.std').length >= 1, 'standings render');

server.close();
rmSync(SITE, { recursive: true, force: true });
console.log(failed === 0 ? '\nALL UI TESTS PASSED' : `\n${failed} UI TEST(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
