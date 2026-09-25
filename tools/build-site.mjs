#!/usr/bin/env node
/**
 * NHL-SCOREBOARD data snapshot (run by GitHub Actions, Node 20+, no dependencies).
 *
 * Fetches LIVE, official NHL data straight from the NHL's own public API
 * (api-web.nhle.com — the same API that powers nhl.com) and writes it
 * verbatim into ./data/ at the repository root. GitHub Pages serves this
 * repo's main branch directly, so committing these files publishes a fresh,
 * first-party snapshot of the league's data.
 *
 * Why server-side fetching? The NHL API sends no Access-Control-Allow-Origin
 * header (verified 2026-09-25 via raw HTTP header inspection), so browsers
 * cannot read it cross-origin from a static site. Fetching it here, from
 * GitHub's infrastructure, keeps the data 100% official and first-party.
 *
 * Endpoints used (each verified against live responses on 2026-09-25):
 *   GET https://api-web.nhle.com/v1/score/now            -> today's focus date + week strip
 *   GET https://api-web.nhle.com/v1/score/{YYYY-MM-DD}   -> any date back to at least 2009-10
 *   GET https://api-web.nhle.com/v1/standings/now        -> current/final standings
 *   GET https://api-web.nhle.com/v1/gamecenter/{id}/play-by-play
 *   GET https://api-web.nhle.com/v1/gamecenter/{id}/boxscore
 *
 * Exit codes: 0 = snapshot written (even if some per-game fetches failed);
 *             1 = core scoreboard unavailable → the caller must NOT publish,
 *                 leaving the previous snapshot live.
 */

import { mkdirSync, writeFileSync, rmSync, readFileSync, renameSync } from 'node:fs';
import path from 'node:path';

// Overridable via env for local testing; defaults to the official NHL API.
const API_BASE = process.env.NHL_API_BASE || 'https://api-web.nhle.com/v1';
const DATA_DIR = process.env.NHL_DATA_DIR || path.join(process.cwd(), 'data');
// Build into staging, then swap atomically at the end — a failed run must
// never wipe the previously published snapshot.
const STAGING_DIR = `${DATA_DIR}.staging`;
const GAMES_DIR = path.join(STAGING_DIR, 'games');
const USER_AGENT =
  'NHL-SCOREBOARD/1.0 (+https://github.com/buffedlizard55-lab/NHL-SCOREBOARD)';

const REQUEST_DELAY_MS = 150; // be polite to the API
const MAX_GAMES_PER_DATE = 20; // detail snapshots per date (safety cap)
const DETAIL_STATES = new Set(['LIVE', 'CRIT', 'OFF', 'FINAL']); // FUT games have no stats yet

const errors = [];
const files = {};

/** Fetch JSON with retries and a timeout. Returns null (never throws). */
async function getJSON(url, tries = 3) {
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      clearTimeout(timer);
      if (attempt === tries) {
        errors.push({ url, error: String((err && err.message) || err) });
        return null;
      }
      await sleep(500 * attempt);
    }
  }
  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeJSON(relPath, json) {
  const full = path.join(STAGING_DIR, relPath);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, JSON.stringify(json));
}

function readWrittenJSON(relPath) {
  try {
    return JSON.parse(readFileSync(path.join(STAGING_DIR, relPath), 'utf8'));
  } catch {
    return null;
  }
}

async function main() {
  // Start from a clean staging snapshot (every file is regenerated below).
  rmSync(STAGING_DIR, { recursive: true, force: true });
  mkdirSync(GAMES_DIR, { recursive: true });

  // 1) Today's scoreboard. /score/now redirects to /score/{currentDate}.
  const scoreNow = await getJSON(`${API_BASE}/score/now`);
  if (!scoreNow || !scoreNow.currentDate) {
    rmSync(STAGING_DIR, { recursive: true, force: true });
    console.error('FATAL: could not fetch /v1/score/now — keeping previous snapshot.');
    process.exit(1);
  }
  const currentDate = scoreNow.currentDate;

  // 2) Scoreboard payloads: the focus date, the previous date ("last night"),
  //    and every date in the API's week strip.
  const scoreDates = new Set([currentDate]);
  if (scoreNow.prevDate) scoreDates.add(scoreNow.prevDate);
  for (const day of scoreNow.gameWeek || []) {
    if (day && day.date) scoreDates.add(day.date);
  }

  for (const date of [...scoreDates].sort()) {
    const payload =
      date === currentDate ? scoreNow : await getJSON(`${API_BASE}/score/${date}`);
    if (payload) {
      writeJSON(`score-${date}.json`, payload);
      files[`score:${date}`] = `data/score-${date}.json`;
    }
    await sleep(REQUEST_DELAY_MS);
  }

  // 3) Standings.
  const standings = await getJSON(`${API_BASE}/standings/now`);
  if (standings) {
    writeJSON('standings-now.json', standings);
    files['standings'] = 'data/standings-now.json';
  }
  await sleep(REQUEST_DELAY_MS);

  // 4) Game detail (play-by-play + boxscore) for every non-future game on the
  //    focus date and the previous date — this covers the everyday use case
  //    (today's slate + last night's results) with zero third-party hops.
  const detailDates = new Set([currentDate]);
  if (scoreNow.prevDate) detailDates.add(scoreNow.prevDate);

  let snapshotted = 0;
  for (const date of [...detailDates].sort()) {
    if (!files[`score:${date}`]) continue;
    const payload = readWrittenJSON(`score-${date}.json`);
    const games = (payload && payload.games) || [];
    let count = 0;
    for (const game of games) {
      if (!game || !game.id) continue;
      if (!DETAIL_STATES.has(game.gameState)) continue;
      if (count >= MAX_GAMES_PER_DATE) break;

      const pbp = await getJSON(`${API_BASE}/gamecenter/${game.id}/play-by-play`);
      if (pbp) {
        writeJSON(`games/${game.id}-pbp.json`, pbp);
        files[`pbp:${game.id}`] = `data/games/${game.id}-pbp.json`;
      }
      await sleep(REQUEST_DELAY_MS);

      const box = await getJSON(`${API_BASE}/gamecenter/${game.id}/boxscore`);
      if (box) {
        writeJSON(`games/${game.id}-boxscore.json`, box);
        files[`box:${game.id}`] = `data/games/${game.id}-boxscore.json`;
      }
      await sleep(REQUEST_DELAY_MS);
      count += 1;
      snapshotted += 1;
    }
  }

  // 5) Manifest — the app reads this first.
  const manifest = {
    generatedAt: new Date().toISOString(),
    apiBase: API_BASE,
    currentDate,
    prevDate: scoreNow.prevDate || null,
    nextDate: scoreNow.nextDate || null,
    snapshottedGames: snapshotted,
    files,
    sources: {
      scoreToday: `${API_BASE}/score/now`,
      scoreByDate: `${API_BASE}/score/{YYYY-MM-DD}`,
      standings: `${API_BASE}/standings/now`,
      playByPlay: `${API_BASE}/gamecenter/{gameId}/play-by-play`,
      boxscore: `${API_BASE}/gamecenter/{gameId}/boxscore`,
      nhlScores: 'https://www.nhl.com/scores',
      nhlStandings: 'https://www.nhl.com/standings',
    },
    errors,
  };
  writeJSON('manifest.json', manifest);

  // Success: swap staging into place atomically.
  rmSync(DATA_DIR, { recursive: true, force: true });
  mkdirSync(path.dirname(DATA_DIR), { recursive: true });
  renameSync(STAGING_DIR, DATA_DIR);

  console.log(
    `Snapshot for ${currentDate}: ${Object.keys(files).length} files, ` +
      `${snapshotted} games detailed, ${errors.length} fetch errors.`
  );
  if (errors.length > 0) {
    console.warn('Non-fatal fetch errors:', JSON.stringify(errors, null, 2));
  }
}

main().catch((err) => {
  console.error('Unexpected snapshot failure:', err);
  process.exit(1);
});
