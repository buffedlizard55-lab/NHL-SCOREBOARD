#!/usr/bin/env node
/**
 * NHL-SCOREBOARD build script (run by GitHub Actions, Node 20+, no dependencies).
 *
 * Copies the static site from docs/ into dist/, then fetches LIVE, official
 * NHL data straight from the NHL's own public API (api-web.nhle.com — the
 * same API that powers nhl.com) and writes it into dist/data/ so the static
 * GitHub Pages site always ships with a fresh, first-party data snapshot.
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
 */

import { cpSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';

// Overridable via env for local testing; defaults to the official NHL API.
const API_BASE = process.env.NHL_API_BASE || 'https://api-web.nhle.com/v1';
const USER_AGENT =
  'NHL-SCOREBOARD/1.0 (+https://github.com/buffedlizard55-lab/NHL-SCOREBOARD)';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DOCS_DIR = path.join(ROOT, 'docs');
const DIST_DIR = process.env.NHL_DIST_DIR || path.join(ROOT, 'dist');
const DATA_DIR = path.join(DIST_DIR, 'data');
const GAMES_DIR = path.join(DATA_DIR, 'games');

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
      const json = await res.json();
      return json;
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
  const full = path.join(DATA_DIR, relPath);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, JSON.stringify(json));
}

async function main() {
  // 1) Stage the static site.
  rmSync(DIST_DIR, { recursive: true, force: true });
  cpSync(DOCS_DIR, DIST_DIR, { recursive: true });
  mkdirSync(GAMES_DIR, { recursive: true });

  // 2) Today's scoreboard. /score/now redirects to /score/{currentDate}.
  const scoreNow = await getJSON(`${API_BASE}/score/now`);
  if (!scoreNow || !scoreNow.currentDate) {
    // Without the core scoreboard we must NOT deploy: fail the job so the
    // previous site stays live.
    writeJSON('manifest.json', {
      generatedAt: new Date().toISOString(),
      apiBase: API_BASE,
      fatal: 'Unable to fetch https://api-web.nhle.com/v1/score/now',
      errors,
    });
    console.error('FATAL: could not fetch /v1/score/now — keeping previous deployment.');
    process.exit(1);
  }
  const currentDate = scoreNow.currentDate;

  // 3) Scoreboard payloads: the focus date, the previous date ("last night"),
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

  // 4) Standings.
  const standings = await getJSON(`${API_BASE}/standings/now`);
  if (standings) {
    writeJSON('standings-now.json', standings);
    files['standings'] = 'data/standings-now.json';
  }
  await sleep(REQUEST_DELAY_MS);

  // 5) Game detail (play-by-play + boxscore) for every non-future game on the
  //    focus date and the previous date — this covers the everyday use case
  //    (today's slate + last night's results) with zero third-party hops.
  const detailDates = new Set([currentDate]);
  if (scoreNow.prevDate) detailDates.add(scoreNow.prevDate);

  let snapshotted = 0;
  for (const date of [...detailDates].sort()) {
    const key = `score:${date}`;
    if (!files[key]) continue;
    const payload = await readWrittenJSON(path.join(DATA_DIR, `score-${date}.json`));
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

  // 6) Manifest — the app reads this first.
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

  console.log(
    `Built snapshot for ${currentDate}: ${Object.keys(files).length} files, ` +
      `${snapshotted} games detailed, ${errors.length} fetch errors.`
  );
  if (errors.length > 0) {
    console.warn('Non-fatal fetch errors:', JSON.stringify(errors, null, 2));
  }
}

/** Read back a JSON file we just wrote (so we reuse exact API payloads). */
async function readWrittenJSON(fullPath) {
  try {
    const { readFileSync } = await import('node:fs');
    return JSON.parse(readFileSync(fullPath, 'utf8'));
  } catch {
    return null;
  }
}

main().catch((err) => {
  console.error('Unexpected build failure:', err);
  process.exit(1);
});
