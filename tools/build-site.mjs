#!/usr/bin/env node
/**
 * NHL-SCOREBOARD data snapshot (run by GitHub Actions, Node 20+, no dependencies).
 *
 * Fetches LIVE, official NHL data straight from the NHL's own public API
 * (api-web.nhle.com — the same API that powers nhl.com) and writes it into
 * ./data/ at the repository root. GitHub Pages serves this repo's main branch
 * directly, so committing these files publishes a fresh, first-party snapshot
 * of the league's data.
 *
 * Why server-side fetching? The NHL API sends no Access-Control-Allow-Origin
 * header (verified 2026-09-25 via raw HTTP header inspection), so browsers
 * cannot read it cross-origin from a static site. Both public pass-through
 * relays were also re-verified DOWN on 2026-09-25 (HTTP 520/522), so anything
 * the site must show reliably has to be snapshotted here, server-side.
 *
 * Endpoints used (each verified against live responses on 2026-09-25):
 *   GET https://api-web.nhle.com/v1/score/now            -> today's focus date + week strip
 *   GET https://api-web.nhle.com/v1/score/{YYYY-MM-DD}   -> any date (verified 1917-12-19 … today)
 *   GET https://api-web.nhle.com/v1/standings/now        -> current/final standings
 *   GET https://api-web.nhle.com/v1/gamecenter/{id}/play-by-play
 *   GET https://api-web.nhle.com/v1/gamecenter/{id}/boxscore
 *   GET https://api-web.nhle.com/v1/club-schedule-season/{team}/{season}
 *                                                          -> every game of a club's season
 *                                                          (verified 1917-18 … current)
 *
 * Output layout:
 *   data/score-{date}.json        VERBATIM official /score/{date} responses (live week window)
 *   data/games/{id}-*.json        VERBATIM official play-by-play / boxscore (live window games)
 *   data/standings-now.json       VERBATIM official standings
 *   data/seasons/{S}/{TEAM}.json  PROJECTED club-season index: a field-for-field subset of the
 *                                 official club-schedule-season response (no values are altered
 *                                 or invented — only irrelevant fields like odds are dropped).
 *                                 Each file records the exact source URL + fetch time.
 *                                 Current season refreshes on a 6h TTL; completed seasons are
 *                                 immutable and copied forward untouched.
 *   data/archive/score-{date}.json PROJECTED /score/{date} responses for completed dates outside
 *                                 the live week (scores + full official scoring summaries).
 *                                 Same projection rule; immutable once every game is final.
 *
 * Exit codes: 0 = snapshot written (even if some per-game fetches failed);
 *             1 = core scoreboard unavailable → the caller must NOT publish,
 *                 leaving the previous snapshot live.
 */

import { mkdirSync, writeFileSync, rmSync, readFileSync, renameSync, readdirSync, existsSync } from 'node:fs';
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

/** Read a file from the PREVIOUS published snapshot (data/), if any. */
function readPublishedJSON(relPath) {
  try {
    return JSON.parse(readFileSync(path.join(DATA_DIR, relPath), 'utf8'));
  } catch {
    return null;
  }
}

/** Season id for a calendar date, e.g. 2026-09-25 -> 20262027, 2026-06-14 -> 20252026. */

function seasonForDate(dateStr) {
  const [y, m] = String(dateStr).split('-').map(Number);
  const startYear = m >= 7 ? y : y - 1; // NHL seasons start in July (draft/free agency); games run Sep–Jun
  return startYear * 10000 + (startYear + 1);
}

function isoWithinHours(iso, hours) {
  try {
    return Date.now() - new Date(iso).getTime() < hours * 3600 * 1000;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* projected snapshots (official fields only — nothing invented)       */
/* ------------------------------------------------------------------ */

const FINAL_STATES = new Set(['FINAL', 'OFF']);

function projectTeam(team) {
  if (!team) return undefined;
  const out = {
    abbrev: team.abbrev,
    name: team.name?.default ?? team.commonName?.default,
    logo: team.logo,
  };
  if (team.score != null) out.score = team.score;
  if (team.sog != null) out.sog = team.sog;
  if (team.record != null) out.record = team.record;
  return out;
}

function projectGoal(goal) {
  return {
    periodDescriptor: goal.periodDescriptor,
    timeInPeriod: goal.timeInPeriod,
    playerId: goal.playerId,
    name: goal.name?.default,
    firstName: goal.firstName?.default,
    lastName: goal.lastName?.default,
    goalModifier: goal.goalModifier,
    assists: (goal.assists || []).map((a) => ({
      playerId: a.playerId, name: a.name?.default, assistsToDate: a.assistsToDate,
    })),
    mugshot: goal.mugshot,
    teamAbbrev: goal.teamAbbrev,
    goalsToDate: goal.goalsToDate,
    awayScore: goal.awayScore,
    homeScore: goal.homeScore,
    strength: goal.strength,
  };
}

/** Minimal per-game projection for the club-season index. */
function projectScheduleGame(g) {
  const out = {
    id: g.id,
    gameType: g.gameType,
    gameDate: g.gameDate,
    startTimeUTC: g.startTimeUTC,
    gameState: g.gameState,
    gameScheduleState: g.gameScheduleState,
    awayTeam: projectTeam(g.awayTeam),
    homeTeam: projectTeam(g.homeTeam),
    gameOutcome: g.gameOutcome,
    gameCenterLink: g.gameCenterLink,
  };
  if (g.venue?.default) out.venue = { default: g.venue.default };
  if (g.periodDescriptor) out.periodDescriptor = g.periodDescriptor;
  if (g.neutralSite) out.neutralSite = true;
  return out;
}

/** Minimal /score/{date} projection: keeps every field the site renders. */
function projectScoreDay(payload, date) {
  const settled = (g) => FINAL_STATES.has(g.gameState) || g.gameScheduleState === 'PPD';
  // A date older than 14 days can never still be "live" — stop refetching it
  // even if the official feed keeps an odd state on some game.
  const longPast = Date.now() - new Date(`${date}T12:00:00Z`).getTime() > 14 * 24 * 3600 * 1000;
  const games = (payload.games || []).map((g) => {
    const out = {
      id: g.id,
      season: g.season,
      gameType: g.gameType,
      gameDate: g.gameDate,
      startTimeUTC: g.startTimeUTC,
      venue: g.venue ? { default: g.venue.default } : undefined,
      venueTimezone: g.venueTimezone,
      gameState: g.gameState,
      gameScheduleState: g.gameScheduleState,
      awayTeam: projectTeam(g.awayTeam),
      homeTeam: projectTeam(g.homeTeam),
      tvBroadcasts: (g.tvBroadcasts || []).map((b) => ({ network: b.network })).slice(0, 4),
      gameCenterLink: g.gameCenterLink,
      periodDescriptor: g.periodDescriptor,
      gameOutcome: g.gameOutcome,
      goals: (g.goals || []).map(projectGoal),
    };
    if (g.threeMinRecap) out.threeMinRecap = g.threeMinRecap;
    if (g.condensedGame) out.condensedGame = g.condensedGame;
    if (g.seriesStatus) out.seriesStatus = g.seriesStatus;
    return out;
  });
  return {
    projectedFrom: `${API_BASE}/score/${date}`,
    fetchedAt: new Date().toISOString(),
    date,
    currentDate: payload.currentDate ?? date,
    prevDate: payload.prevDate ?? undefined,
    nextDate: payload.nextDate ?? undefined,
    gameWeek: Array.isArray(payload.gameWeek)
      ? payload.gameWeek.map((d) => ({ date: d.date, dayAbbrev: d.dayAbbrev, numberOfGames: d.numberOfGames }))
      : undefined,
    complete: games.length > 0 && (games.every(settled) || longPast),
    games,
  };
}

const SEASON_TTL_HOURS = 6;
const ARCHIVE_FETCH_CAP = 60; // max /score/{date} backfill fetches per run (resumable)

async function snapshotOneSeason(seasonId, teamList, isCurrent) {
  let previousSeasonSeen = null;
  for (const team of teamList) {
    const fileRel = `seasons/${seasonId}/${team}.json`;
    const old = readPublishedJSON(fileRel);
    if (old && old.season === seasonId && old.team === team) {
      // Completed seasons are immutable; the current season refreshes on a TTL.
      const reusable = isCurrent ? isoWithinHours(old.fetchedAt, SEASON_TTL_HOURS) : true;
      if (reusable) {
        writeJSON(fileRel, old);
        files[`season:${team}:${seasonId}`] = `data/${fileRel}`;
        continue;
      }
    }
    const url = `${API_BASE}/club-schedule-season/${team}/${seasonId}`;
    const payload = await getJSON(url);
    if (!payload || !Array.isArray(payload.games)) {
      errors.push({ url, error: 'unavailable' });
      continue;
    }
    if (payload.previousSeason && !previousSeasonSeen) previousSeasonSeen = payload.previousSeason;
    writeJSON(fileRel, {
      projectedFrom: url,
      fetchedAt: new Date().toISOString(),
      season: seasonId,
      team,
      games: payload.games.map(projectScheduleGame),
    });
    files[`season:${team}:${seasonId}`] = `data/${fileRel}`;
    await sleep(REQUEST_DELAY_MS);
  }
  return previousSeasonSeen;
}

/**
 * Snapshot club-season indexes (current + previous season, every club in the
 * official standings) and the completed-date score archive. Fully resumable:
 * completed seasons and complete archive dates are copied forward untouched.
 */
async function snapshotSeasons(currentSeason, currentDate, teamList) {
  const result = { current: currentSeason, previous: null, teams: teamList, archiveDates: 0 };
  if (!teamList.length) return result;

  // Current season first; the official response names the previous season.
  let previousSeason = await snapshotOneSeason(currentSeason, teamList, true);
  if (!previousSeason || previousSeason === currentSeason) {
    // Fallback: NHL season ids are contiguous (20252026 -> 20242025).
    previousSeason = currentSeason - 10001;
  }
  if (previousSeason !== currentSeason) {
    await snapshotOneSeason(previousSeason, teamList, false);
  }
  result.previous = previousSeason;

  // Copy forward season indexes for any OTHER season already published
  // (completed seasons are immutable history).
  const publishedSeasonsRoot = path.join(DATA_DIR, 'seasons');
  if (existsSync(publishedSeasonsRoot)) {
    for (const entry of readdirSync(publishedSeasonsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const season = Number(entry.name);
      if (!Number.isInteger(season) || season === currentSeason || season === previousSeason) continue;
      for (const f of readdirSync(path.join(publishedSeasonsRoot, entry.name))) {
        if (!f.endsWith('.json')) continue;
        const team = f.replace(/\.json$/, '');
        const rel = `seasons/${season}/${f}`;
        const old = readPublishedJSON(rel);
        if (old && old.season === season && old.team === team) {
          writeJSON(rel, old);
          files[`season:${team}:${season}`] = `data/${rel}`;
        }
      }
    }
  }

  // ---- completed-date score archive --------------------------------------
  // 1) Copy forward every already-complete archive date (immutable).
  const publishedArchive = path.join(DATA_DIR, 'archive');
  if (existsSync(publishedArchive)) {
    for (const f of readdirSync(publishedArchive)) {
      if (!/^score-\d{4}-\d{2}-\d{2}\.json$/.test(f)) continue;
      const rel = `archive/${f}`;
      const old = readPublishedJSON(rel);
      if (old && old.complete) {
        writeJSON(rel, old);
        if (!files[`score:${old.date}`]) files[`score:${old.date}`] = `data/${rel}`;
        result.archiveDates += 1;
      }
    }
  }

  // 2) Collect candidate dates from the season indexes now in staging.
  const dateSet = new Set();
  for (const [key, rel] of Object.entries(files)) {
    if (!key.startsWith('season:')) continue;
    // manifest paths are web-facing ("data/..."); staging files are relative to it
    const data = readWrittenJSON(String(rel).replace(/^data\//, ''));
    for (const g of (data?.games) || []) {
      if (g.gameDate && g.gameDate < currentDate) dateSet.add(g.gameDate);
    }
  }

  // 3) Fetch missing/incomplete past dates, newest first, capped per run.
  const candidates = [...dateSet]
    .filter((d) => {
      if (files[`score:${d}`]) return false; // covered by the verbatim live window
      const old = readPublishedJSON(`archive/score-${d}.json`);
      return !(old && old.complete);
    })
    .sort((a, b) => (a < b ? 1 : -1));

  let fetched = 0;
  for (const date of candidates) {
    if (fetched >= ARCHIVE_FETCH_CAP) break;
    const payload = await getJSON(`${API_BASE}/score/${date}`);
    if (!payload || !Array.isArray(payload.games)) continue;
    const rel = `archive/score-${date}.json`;
    writeJSON(rel, projectScoreDay(payload, date));
    if (!files[`score:${date}`]) files[`score:${date}`] = `data/${rel}`;
    result.archiveDates += 1;
    fetched += 1;
    await sleep(REQUEST_DELAY_MS);
  }

  return result;
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

  // 4) Season indexes + completed-date archive (projected from official
  //    responses; failures here are non-fatal — the live window still ships).
  let seasonsMeta = null;
  try {
    const currentSeason = (scoreNow.games || []).find((g) => g && g.season)?.season
      || seasonForDate(currentDate);
    const teamList = [...new Set(
      (standings?.standings || [])
        .map((t) => t?.teamAbbrev?.default)
        .filter((a) => typeof a === 'string' && /^[A-Z]{3}$/.test(a)),
    )].sort();
    seasonsMeta = await snapshotSeasons(currentSeason, currentDate, teamList);
  } catch (err) {
    errors.push({ url: 'seasons/archive snapshot', error: String((err && err.message) || err) });
  }

  // 5) Game detail (play-by-play + boxscore) for every non-future game on the
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
    seasons: seasonsMeta,
    files,
    sources: {
      scoreToday: `${API_BASE}/score/now`,
      scoreByDate: `${API_BASE}/score/{YYYY-MM-DD}`,
      standings: `${API_BASE}/standings/now`,
      playByPlay: `${API_BASE}/gamecenter/{gameId}/play-by-play`,
      boxscore: `${API_BASE}/gamecenter/{gameId}/boxscore`,
      clubScheduleSeason: `${API_BASE}/club-schedule-season/{teamAbbrev}/{seasonId}`,
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
      `${snapshotted} games detailed, ${errors.length} fetch errors.` +
      (seasonsMeta
        ? ` Seasons: current ${seasonsMeta.current}, previous ${seasonsMeta.previous} ` +
          `(${seasonsMeta.teams.length} clubs); archive dates: ${seasonsMeta.archiveDates}.`
        : '')
  );
  if (errors.length > 0) {
    console.warn('Non-fatal fetch errors:', JSON.stringify(errors, null, 2));
  }
}

main().catch((err) => {
  console.error('Unexpected snapshot failure:', err);
  process.exit(1);
});
