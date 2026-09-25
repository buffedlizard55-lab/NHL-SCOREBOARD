#!/usr/bin/env node
/**
 * Local test harness for tools/build-site.mjs (no external network required).
 *
 * Spawns tools/fixture-server.mjs (which mimics the SHAPE of the official
 * api-web.nhle.com responses, verified against real payloads 2026-09-25),
 * runs the snapshot script against it, then asserts the data/ output.
 *
 *   node tools/test-build.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';

const PORT = 8791;
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DATA = path.join(ROOT, '.test-dist', 'data');

rmSync(DATA, { recursive: true, force: true });

const server = spawn('node', ['tools/fixture-server.mjs'], {
  cwd: ROOT,
  env: { ...process.env, NHL_TEST_PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'inherit'],
});

try {
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('fixture server did not start')), 8000);
    server.stdout.on('data', (chunk) => {
      if (chunk.toString().includes('READY')) { clearTimeout(t); resolve(); }
    });
    server.on('exit', () => reject(new Error('fixture server exited early')));
  });
} catch (err) {
  server.kill();
  console.error(err.message);
  process.exit(1);
}

const result = spawnSync('node', ['tools/build-site.mjs'], {
  cwd: ROOT,
  env: {
    ...process.env,
    NHL_API_BASE: `http://127.0.0.1:${PORT}/v1`,
    NHL_DATA_DIR: DATA,
  },
  encoding: 'utf8',
});
server.kill();

process.stdout.write(result.stdout || '');
process.stderr.write(result.stderr || '');
if (result.status !== 0) {
  console.error('SNAPSHOT FAILED with status', result.status);
  process.exit(1);
}

// ---- assertions ----
let failed = 0;
const check = (cond, label) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failed += 1;
};

check(existsSync(path.join(DATA, 'manifest.json')), 'manifest written');

const manifest = JSON.parse(readFileSync(path.join(DATA, 'manifest.json'), 'utf8'));
check(manifest.currentDate === '2026-09-25', 'manifest.currentDate');
check(manifest.files['score:2026-09-25'] === 'data/score-2026-09-25.json', 'score file registered');
check(manifest.files['pbp:2026010027'] === 'data/games/2026010027-pbp.json', 'pbp registered');
check(manifest.files['box:2026010027'] === 'data/games/2026010027-boxscore.json', 'boxscore registered');
check(manifest.files['pbp:2026010024'] === 'data/games/2026010024-pbp.json', 'prev-day pbp registered');
check(manifest.files['standings'] === 'data/standings-now.json', 'standings registered');
check(manifest.errors.length === 0, `no fetch errors (got ${manifest.errors.length})`);
check(existsSync(path.join(DATA, 'games', '2026010027-pbp.json')), 'pbp file on disk');
check(existsSync(path.join(DATA, 'score-2026-09-26.json')), 'week-strip dates fetched');

const pbpPath = path.join(DATA, 'games', '2026010027-pbp.json');
if (existsSync(pbpPath)) {
  const pbpFile = JSON.parse(readFileSync(pbpPath, 'utf8'));
  check(Array.isArray(pbpFile.plays) && pbpFile.plays.length === 4, 'pbp payload intact');
} else {
  check(false, 'pbp payload intact (file missing)');
}

// Fatal-path behavior: unreachable API must exit 1 AND leave the existing
// snapshot untouched (staging-swap design).
const generatedBefore = manifest.generatedAt;
const fatal = spawnSync('node', ['tools/build-site.mjs'], {
  cwd: ROOT,
  env: {
    ...process.env,
    NHL_API_BASE: 'http://127.0.0.1:1/v1', // nothing listens here
    NHL_DATA_DIR: DATA,
  },
  encoding: 'utf8',
  timeout: 30000,
});
check(fatal.status === 1, 'unreachable API exits non-zero');
check(
  JSON.parse(readFileSync(path.join(DATA, 'manifest.json'), 'utf8')).generatedAt === generatedBefore,
  'failed run preserved the previous snapshot'
);

console.log(failed === 0 ? '\nALL TESTS PASSED' : `\n${failed} TEST(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
