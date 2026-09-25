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

// ---- assertions (run 1: fresh snapshot) ----
let failed = 0;
const check = (cond, label) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failed += 1;
};

async function requestCounts() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/__requests`);
    return await res.json();
  } catch {
    return {};
  }
}
const clubScheduleHits = (counts) => Object.entries(counts)
  .filter(([url]) => url.includes('/club-schedule-season/'))
  .reduce((n, [, c]) => n + c, 0);
const archiveScoreHits = (counts) => Object.entries(counts)
  .filter(([url]) => /^\/v1\/score\/(2025-10-10|2026-04-17|2026-09-19|2026-09-20|2026-09-21)$/.test(url))
  .reduce((n, [, c]) => n + c, 0);

const counts1 = await requestCounts();
const clubHits1 = clubScheduleHits(counts1);
const archiveHits1 = archiveScoreHits(counts1);

process.stdout.write(result.stdout || '');
process.stderr.write(result.stderr || '');
if (result.status !== 0) {
  console.error('SNAPSHOT FAILED with status', result.status);
  server.kill();
  process.exit(1);
}

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

// ---- seasons & archive (run 1) ----
check(manifest.seasons?.current === 20262027, `manifest.seasons.current (got ${manifest.seasons?.current})`);
check(manifest.seasons?.previous === 20252026, `manifest.seasons.previous (got ${manifest.seasons?.previous})`);
check(JSON.stringify(manifest.seasons?.teams) === JSON.stringify(['BOS', 'BUF', 'COL']), 'seasons team list from standings');
for (const team of ['BOS', 'BUF', 'COL']) {
  for (const season of [20262027, 20252026]) {
    check(
      manifest.files[`season:${team}:${season}`] === `data/seasons/${season}/${team}.json`,
      `season index registered: ${team} ${season}`
    );
    check(existsSync(path.join(DATA, 'seasons', String(season), `${team}.json`)), `season file on disk: ${team} ${season}`);
  }
}
const seasonFile = JSON.parse(readFileSync(path.join(DATA, 'seasons', '20262027', 'BUF.json'), 'utf8'));
check(seasonFile.projectedFrom === 'http://127.0.0.1:8791/v1/club-schedule-season/BUF/20262027', 'season file records its official source URL');
check(seasonFile.team === 'BUF' && Array.isArray(seasonFile.games) && seasonFile.games.length === 5, 'season file holds the club games');
check(seasonFile.games.every((g) => g.awayTeam?.abbrev && g.homeTeam?.abbrev && g.gameDate), 'season projection keeps identity fields');

// archive: past dates from the club schedules get archived…
for (const d of ['2026-09-19', '2026-09-20', '2026-09-21', '2025-10-10', '2026-04-17']) {
  check(manifest.files[`score:${d}`] === `data/archive/score-${d}.json`, `archive date registered: ${d}`);
}
// …but dates covered by the verbatim live window never point at the archive…
check(manifest.files['score:2026-09-24'] === 'data/score-2026-09-24.json', 'verbatim score wins over archive for live-window dates');
check(manifest.files['score:2026-09-26'] === 'data/score-2026-09-26.json', 'future week date stays verbatim');
// …and future club-schedule dates are not archived at all.
check(!existsSync(path.join(DATA, 'archive', 'score-2026-09-26.json')), 'future dates are not archived');

const archivedDay = JSON.parse(readFileSync(path.join(DATA, 'archive', 'score-2026-09-19.json'), 'utf8'));
check(archivedDay.complete === true, 'archive day marked complete when all games are final');
check(Array.isArray(archivedDay.games) && archivedDay.games.length === 1, 'archive day keeps games');
check(archivedDay.games[0]?.goals?.[0]?.name === 'J. Faulk', 'archive day keeps the official scoring summary');
check(archivedDay.gameWeek === undefined || Array.isArray(archivedDay.gameWeek), 'archive week strip well-formed');

check(clubHits1 === 6, `first run fetched each club season once (got ${clubHits1})`);
check(archiveHits1 === 5, `first run archived the 5 missing past dates (got ${archiveHits1})`);

// ---- run 2: TTL reuse + immutable copy-forward ----
const result2 = spawnSync('node', ['tools/build-site.mjs'], {
  cwd: ROOT,
  env: {
    ...process.env,
    NHL_API_BASE: `http://127.0.0.1:${PORT}/v1`,
    NHL_DATA_DIR: DATA,
  },
  encoding: 'utf8',
});
process.stdout.write(result2.stdout || '');
process.stderr.write(result2.stderr || '');
if (result2.status !== 0) {
  console.error('SECOND SNAPSHOT FAILED with status', result2.status);
  server.kill();
  process.exit(1);
}
const counts2 = await requestCounts();
const clubHits2 = clubScheduleHits(counts2);
const archiveHits2 = archiveScoreHits(counts2);
check(clubHits2 === clubHits1, `second run reused season snapshots — no refetch (got ${clubHits2 - clubHits1} extra)`);
check(archiveHits2 === archiveHits1, `second run reused complete archive dates (got ${archiveHits2 - archiveHits1} extra)`);

const manifest2 = JSON.parse(readFileSync(path.join(DATA, 'manifest.json'), 'utf8'));
check(manifest2.files['season:BUF:20252026'] === 'data/seasons/20252026/BUF.json', 'immutable previous season carried forward');
check(manifest2.files['score:2025-10-10'] === 'data/archive/score-2025-10-10.json', 'archive carried forward');
check(manifest2.seasons?.previous === 20252026, 'previous season still known on reuse run');
check(manifest2.errors.length === 0, `second run: no fetch errors (got ${manifest2.errors.length})`);

const pbpPath = path.join(DATA, 'games', '2026010027-pbp.json');
if (existsSync(pbpPath)) {
  const pbpFile = JSON.parse(readFileSync(pbpPath, 'utf8'));
  check(Array.isArray(pbpFile.plays) && pbpFile.plays.length === 4, 'pbp payload intact');
} else {
  check(false, 'pbp payload intact (file missing)');
}

// Fatal-path behavior: unreachable API must exit 1 AND leave the existing
// snapshot untouched (staging-swap design).
const generatedBefore = manifest2.generatedAt;
server.kill(); // the fatal run must not need it
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
