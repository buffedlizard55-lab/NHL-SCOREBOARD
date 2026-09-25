/* NHL Scoreboard — vanilla JS, zero dependencies.
 *
 * Data policy: every stat is fetched from the NHL's official public API
 * (api-web.nhle.com — the API behind nhl.com). Preference order:
 *   1. Official snapshot shipped with this site (refreshed every 5 minutes
 *      by GitHub Actions calling the NHL endpoints server-side).
 *   2. A direct browser fetch of the official endpoint (works only if the
 *      NHL ever enables cross-origin access — it currently does not).
 *   3. Transparent pass-through transports (required because the NHL API
 *      sends no Access-Control-Allow-Origin header; verified 2026-09-25).
 * The source actually used is always surfaced in the status bar.
 */
'use strict';

const API_BASE = 'https://api-web.nhle.com/v1';
const NHL_BASE = 'https://www.nhl.com';
const POLL_MS = 20000;
const SNAPSHOT_STALE_MS = 12 * 60 * 1000;

/* Pass-through transports of last resort (the bytes still come from the
 * official NHL URL shown in the status bar; each relay was tested 2026-09-25
 * and is used only when it actually answers with valid JSON). */
const RELAYS = [
  (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
  (u) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}`,
];

const $ = (sel, root = document) => root.querySelector(sel);

/* ------------------------------------------------------------------ */
/* small utilities                                                     */
/* ------------------------------------------------------------------ */

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function localized(obj, lang) {
  if (!obj) return '';
  if (typeof obj === 'string') return obj;
  return obj.default ?? obj.en ?? obj[lang] ?? Object.values(obj)[0] ?? '';
}

function fmtDateInput(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const dateTimeFmt = new Intl.DateTimeFormat(undefined, {
  weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
});
const niceDateFmt = new Intl.DateTimeFormat(undefined, {
  weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
});

function fmtTime(iso) { try { return timeFmt.format(new Date(iso)); } catch { return ''; } }
function fmtDateTime(iso) { try { return dateTimeFmt.format(new Date(iso)); } catch { return ''; } }

function venueTime(game) {
  try {
    const fmt = new Intl.DateTimeFormat(undefined, {
      hour: 'numeric', minute: '2-digit',
      timeZone: game.venueTimezone || 'America/New_York',
      timeZoneName: 'short',
    });
    return fmt.format(new Date(game.startTimeUTC));
  } catch { return fmtTime(game.startTimeUTC); }
}

function periodLabel(pd) {
  if (!pd) return '';
  if (pd.periodType === 'SO') return 'SO';
  if (pd.periodType === 'OT') return pd.number <= 4 ? 'OT' : `${pd.number - 3}OT`;
  return [' ', '1st', '2nd', '3rd'][pd.number] || `${pd.number}th`;
}

function gameKind(game) {
  if (game.gameType === 1) return 'PRE';
  if (game.gameType === 3) return 'PLAYOFFS';
  return '';
}

function isLiveGame(g) {
  return Boolean(g && (g.gameState === 'LIVE' || g.gameState === 'CRIT'));
}
function isFinalGame(g) {
  return Boolean(g && (g.gameState === 'FINAL' || g.gameState === 'OFF'));
}

function statusBadge(g) {
  if (g.gameScheduleState === 'PPD') return { cls: 'upcoming', text: 'POSTPONED' };
  if (isLiveGame(g)) {
    const clock = g.clock || {};
    const where = clock.inIntermission
      ? 'Intermission'
      : `${periodLabel(g.periodDescriptor)} ${clock.timeRemaining || ''}`.trim();
    return { cls: 'live', text: `LIVE${where ? ' · ' + esc(where) : ''}`, live: true };
  }
  if (isFinalGame(g)) {
    const suffix = periodLabel(g.periodDescriptor) || '';
    const extra = suffix && suffix !== '3rd' ? `/${suffix}` : '';
    return { cls: 'final', text: `FINAL${extra}` };
  }
  return { cls: 'upcoming', text: fmtTime(g.startTimeUTC) || 'UPCOMING' };
}

function seriesLine(s) {
  if (!s) return '';
  const top = s.topSeedTeamAbbrev, bottom = s.bottomSeedTeamAbbrev;
  let state;
  if (s.topSeedWins > s.bottomSeedWins) state = `${top} lead ${s.topSeedWins}–${s.bottomSeedWins}`;
  else if (s.bottomSeedWins > s.topSeedWins) state = `${bottom} lead ${s.bottomSeedWins}–${s.topSeedWins}`;
  else state = `Series tied ${s.topSeedWins}–${s.bottomSeedWins}`;
  return `${s.seriesTitle || s.seriesAbbrev || 'Playoffs'} · Game ${s.gameNumberOfSeries} · ${state}`;
}

/* ------------------------------------------------------------------ */
/* season utilities (pure — unit-tested in tools/test-app.mjs)         */
/* ------------------------------------------------------------------ */

const FIRST_NHL_SEASON = 19171918;      // league's first season (verified vs official API)
const CANCELLED_SEASON = 20042005;      // cancelled outright — no games exist (API returns 404)

/** Season id for a calendar date: 2026-09-25 -> 20262027, 2026-06-14 -> 20252026. */
function seasonForDate(dateStr) {
  const [y, m] = String(dateStr || '').split('-').map(Number);
  if (!y || !m) return null;
  const startYear = m >= 7 ? y : y - 1;
  return startYear * 10000 + (startYear + 1);
}

/** "20252026" -> "2025-26" */
function seasonLabel(seasonId) {
  const s = String(seasonId);
  return `${s.slice(0, 4)}-${s.slice(6)}`;
}

/**
 * Every NHL season id from 1917-18 through `currentSeasonId`, oldest first,
 * excluding 2004-05 (cancelled — the official API returns 404 for it).
 */
function seasonList(currentSeasonId) {
  const list = [];
  for (let s = FIRST_NHL_SEASON; s <= currentSeasonId; s += 10001) {
    if (s === CANCELLED_SEASON) continue;
    list.push(s);
  }
  return list;
}

/** Result of one game from a club's perspective; null when not yet played. */
function gameResultFor(game, teamAbbrev) {
  const isHome = game.homeTeam?.abbrev === teamAbbrev;
  const us = isHome ? game.homeTeam : game.awayTeam;
  const them = isHome ? game.awayTeam : game.homeTeam;
  if (us?.score == null || them?.score == null) return null;
  const extra = game.gameOutcome?.lastPeriodType;
  const suffix = extra === 'OT' ? '-OT' : extra === 'SO' ? '-SO' : '';
  if (us.score > them.score) return { code: 'W', label: `W${suffix}`, win: true };
  if (us.score < them.score) return { code: suffix ? 'OTL' : 'L', label: suffix ? `L${suffix}` : 'L', win: false };
  return { code: 'T', label: 'T', win: false }; // ties existed before 2005-06
}

/**
 * Club record computed from official per-game results.
 * Points follow the league rules of the era: the OT-loss point was introduced
 * in 1999-2000, so OT losses before that count as plain losses (0 points).
 */
function seasonRecord(games, teamAbbrev, seasonId) {
  const rec = { w: 0, l: 0, t: 0, otl: 0, pts: 0, gf: 0, ga: 0, gp: 0 };
  const otlWorthPoint = seasonId == null || seasonId >= 19992000;
  for (const g of games || []) {
    const isHome = g.homeTeam?.abbrev === teamAbbrev;
    const us = isHome ? g.homeTeam : g.awayTeam;
    const them = isHome ? g.awayTeam : g.homeTeam;
    if (us?.score == null || them?.score == null) continue;
    rec.gp += 1;
    rec.gf += us.score;
    rec.ga += them.score;
    const r = gameResultFor(g, teamAbbrev);
    if (!r) continue;
    if (r.code === 'W') { rec.w += 1; rec.pts += 2; }
    else if (r.code === 'T') { rec.t += 1; rec.pts += 1; }
    else if (r.code === 'OTL') { rec.otl += 1; if (otlWorthPoint) rec.pts += 1; }
    else rec.l += 1;
  }
  return rec;
}

/* ------------------------------------------------------------------ */
/* data layer                                                          */
/* ------------------------------------------------------------------ */

let manifest = null;
let lastTransport = null; // 'snapshot' | 'direct' | 'relay'

async function fetchLocal(relPath) {
  try {
    const bust = manifest?.generatedAt ? `?v=${encodeURIComponent(manifest.generatedAt)}` : `?v=${Date.now()}`;
    const res = await fetch(`${relPath}${bust}`, { cache: 'no-store' });
    if (!res.ok) return null;
    const json = await res.json();
    return json && typeof json === 'object' ? json : null;
  } catch { return null; }
}

async function loadManifest() {
  try {
    const res = await fetch(`data/manifest.json?v=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) { manifest = null; return; }
    const json = await res.json();
    if (json && typeof json === 'object' && !json.fatal) manifest = json;
  } catch { manifest = null; }
}

/** Direct call to the official NHL API from the browser. */
async function fetchDirect(apiPath) {
  try {
    const res = await fetch(API_BASE + apiPath, { cache: 'no-store' });
    if (!res.ok) return null;
    const json = await res.json();
    return json && typeof json === 'object' ? json : null;
  } catch { return null; } // blocked by CORS in today's browsers — expected
}

/** Pass-through transports (data still originates from the NHL URL). */
async function fetchViaRelay(apiPath) {
  for (const make of RELAYS) {
    try {
      const res = await fetch(make(API_BASE + apiPath), { cache: 'no-store' });
      if (!res.ok) continue;
      const text = await res.text();
      if (/<html/i.test(text.slice(0, 200))) continue;
      const json = JSON.parse(text);
      if (json && typeof json === 'object' && !json.error) return json;
    } catch { /* try next relay */ }
  }
  return null;
}

/**
 * Fetch an official NHL API payload.
 * @param apiPath     e.g. '/score/2026-09-25'
 * @param snapshotKey e.g. 'score:2026-09-25' — matching key in manifest.files
 */
async function fetchOfficial(apiPath, snapshotKey) {
  if (manifest?.files?.[snapshotKey]) {
    const data = await fetchLocal(manifest.files[snapshotKey]);
    if (data) { lastTransport = 'snapshot'; return data; }
  }
  const direct = await fetchDirect(apiPath);
  if (direct) { lastTransport = 'direct'; return direct; }
  const relayed = await fetchViaRelay(apiPath);
  if (relayed) { lastTransport = 'relay'; return relayed; }
  return null;
}

function setStatus(kind, text, tooltip) {
  const el = $('#data-status');
  el.className = `data-status ${kind}`;
  el.textContent = text;
  if (tooltip) el.title = tooltip;
}

function describeTransport() {
  if (manifest) {
    const age = Date.now() - new Date(manifest.generatedAt).getTime();
    const at = new Date(manifest.generatedAt).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
    if (age > SNAPSHOT_STALE_MS) {
      setStatus('warn', `Official snapshot aging (${Math.round(age / 60000)} min) — ${at}`,
        'Snapshot of api-web.nhle.com taken by our scheduled job; redeploy pending.');
    } else {
      setStatus('ok', `Official NHL snapshot · ${at}`,
        `Fresh copy of api-web.nhle.com responses, fetched server-side at ${at}.`);
    }
  } else if (lastTransport === 'direct') {
    setStatus('ok', 'Live from api-web.nhle.com (official)', API_BASE);
  } else if (lastTransport === 'relay') {
    setStatus('warn', 'Official NHL data via pass-through transport',
      `Source: ${API_BASE} — routed through a public transport because the NHL API sends no CORS permission.`);
  }
}

/* ------------------------------------------------------------------ */
/* state & router                                                      */
/* ------------------------------------------------------------------ */

const state = {
  view: 'board',
  boardDate: null,
  boardPayload: null,
  game: null, // { id, date, game, box, pbp }
  pollTimer: null,
  liveRefresh: true,
};

function switchView(name) {
  state.view = name;
  document.querySelectorAll('.tab').forEach((t) => {
    const active = t.dataset.view === name || (name === 'game' && t.dataset.view === 'board');
    t.classList.toggle('active', active);
    t.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  for (const v of ['board', 'game', 'seasons', 'standings', 'about']) {
    $(`#view-${v}`).hidden = v !== name;
  }
}

async function route() {
  const hash = location.hash || '#/board';
  const parts = hash.replace(/^#\//, '').split('/').filter(Boolean);
  if (parts[0] === 'standings') { switchView('standings'); renderStandings(); }
  else if (parts[0] === 'about') { switchView('about'); }
  else if (parts[0] === 'seasons') { switchView('seasons'); renderSeasons(null, null); }
  else if (parts[0] === 'season' && parts[1]) {
    switchView('seasons');
    const season = parts[2] != null && Number.isInteger(Number(parts[2])) ? Number(parts[2]) : null;
    renderSeasons(parts[1].toUpperCase(), season);
  }
  else if (parts[0] === 'game' && parts[1]) { switchView('game'); renderGameView(parts[1], parts[2] || null); }
  else { switchView('board'); renderBoard(parts[1] || null); }
}

window.addEventListener('hashchange', route);

/* ------------------------------------------------------------------ */
/* scoreboard                                                          */
/* ------------------------------------------------------------------ */

async function fetchScore(date) {
  if (date) return fetchOfficial(`/score/${date}`, `score:${date}`);
  // "Today" = the NHL's current focus date.
  if (manifest?.currentDate && manifest.files?.[`score:${manifest.currentDate}`]) {
    return fetchOfficial(`/score/${manifest.currentDate}`, `score:${manifest.currentDate}`);
  }
  return fetchOfficial('/score/now', null);
}

async function renderBoard(date) {
  const content = $('#board-content');
  content.innerHTML = '<div class="notice"><span class="spinner"></span>Loading the official scoreboard…</div>';
  renderWeekStrip(null);

  const payload = await fetchScore(date);
  if (!payload) {
    const officialDate = date ? `${API_BASE}/score/${encodeURIComponent(date)}` : `${API_BASE}/score/now`;
    content.innerHTML = `
      <div class="notice">
        Could not load the NHL scoreboard right now (no local snapshot for this date, and the
        NHL API sends no cross-origin permission for browsers).<br>
        You can always check the official source directly:
        <div><a class="btn" href="${officialDate}" target="_blank" rel="noopener">Raw official scoreboard JSON ↗</a>
        <a class="btn" href="${NHL_BASE}/scores" target="_blank" rel="noopener">NHL.com Scores ↗</a>
        <button class="btn" onclick="route()">Try again</button></div>
      </div>`;
    setStatus('warn', 'Data unavailable', `Failed to reach ${API_BASE}`);
    return;
  }

  state.boardPayload = payload;
  state.boardDate = payload.currentDate;
  describeTransport();
  renderWeekStrip(payload);

  const dateInput = $('#date-input');
  dateInput.value = payload.currentDate;

  const games = payload.games || [];
  if (!games.length) {
    content.innerHTML = `
      <div class="notice">
        No NHL games on ${esc(niceDateFmt.format(new Date(payload.currentDate + 'T12:00:00')))}.
        <div>
          ${payload.prevDate ? `<a class="btn" href="#/board/${payload.prevDate}">◀ ${payload.prevDate}</a>` : ''}
          ${payload.nextDate ? `<a class="btn" href="#/board/${payload.nextDate}">${payload.nextDate} ▶</a>` : ''}
        </div>
      </div>`;
    return;
  }

  const sorted = [...games].sort((a, b) => {
    const la = isLiveGame(a) ? 0 : 1;
    const lb = isLiveGame(b) ? 0 : 1;
    if (la !== lb) return la - lb;
    return String(a.startTimeUTC).localeCompare(String(b.startTimeUTC));
  });

  content.innerHTML = sorted.map((g) => gameCard(g, payload)).join('');
}

function renderWeekStrip(payload) {
  const strip = $('#week-strip');
  if (!payload || !Array.isArray(payload.gameWeek)) { strip.innerHTML = ''; return; }
  strip.innerHTML = payload.gameWeek.map((d) => {
    const dt = new Date(d.date + 'T12:00:00');
    const label = new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(dt);
    const dayNum = dt.getDate();
    const current = d.date === payload.currentDate ? ' current' : '';
    return `<button class="day-chip${current}" data-date="${esc(d.date)}" title="${esc(d.date)}">
      <b>${esc(label)}</b><span>${dayNum}</span>
      <span class="cnt">${d.numberOfGames ? d.numberOfGames + ' game' + (d.numberOfGames > 1 ? 's' : '') : 'off'}</span>
    </button>`;
  }).join('');
  strip.querySelectorAll('.day-chip').forEach((chip) => {
    chip.addEventListener('click', () => { location.hash = `#/board/${chip.dataset.date}`; });
  });
}

function gameCard(g, payload) {
  const badge = statusBadge(g);
  const kind = gameKind(g);
  const final = isFinalGame(g);
  const away = g.awayTeam, home = g.homeTeam;

  const teamRow = (team, isAway) => {
    let cls = '';
    if (final && away.score !== home.score) {
      const won = isAway ? away.score > home.score : home.score > away.score;
      cls = won ? ' winner' : ' loser';
    }
    const scoreCell = (final || isLiveGame(g))
      ? `<div class="tscore">${team.score ?? 0}</div>` : '<div class="tscore"></div>';
    const record = team.record ? `<small>${esc(team.record)}</small>` : '';
    return `<div class="team-row${cls}">
      <img src="${esc(team.logo)}" alt="" loading="lazy">
      <div class="tname"><b>${esc(team.abbrev)}</b><small>${esc(localized(team.name) || localized(team.commonName) || team.abbrev)}</small>${record}</div>
      ${scoreCell}
    </div>`;
  };

  const meta = [];
  if (g.venue) meta.push(`<span>🏟 ${esc(localized(g.venue))}</span>`);
  if (g.startTimeUTC) meta.push(`<span>🕒 ${esc(venueTime(g))}</span>`);
  const tv = (g.tvBroadcasts || []).map((b) => b.network).filter(Boolean);
  if (tv.length && !final) meta.push(`<span>📺 ${esc(tv.slice(0, 3).join(', '))}</span>`);
  if (final && away.sog != null && home.sog != null) meta.push(`<span>SOG ${away.sog}–${home.sog}</span>`);

  const recap = g.threeMinRecap
    ? `<a class="btn" href="${NHL_BASE}${esc(g.threeMinRecap)}" target="_blank" rel="noopener">Recap ↗</a>` : '';
  const series = g.seriesStatus ? `<div class="gc-series">${esc(seriesLine(g.seriesStatus))}</div>` : '';

  return `<article class="game-card${isLiveGame(g) ? ' live' : ''}">
    <div class="gc-top">
      <span class="badge ${badge.cls}">${badge.live ? '<span class="live-dot"></span>' : ''}${badge.text}</span>
      ${kind ? `<span class="badge kind">${kind}</span>` : ''}
      <span class="spacer"></span>
      <a href="${NHL_BASE}${esc(g.gameCenterLink || '')}" target="_blank" rel="noopener"
         title="Verify on the official NHL.com Game Center">NHL.com ↗</a>
    </div>
    ${teamRow(away, true)}
    ${teamRow(home, false)}
    ${series}
    <div class="gc-meta">${meta.join('')}</div>
    <div class="gc-actions">
      <button class="btn btn-accent" data-open="${g.id}" data-date="${esc(payload.currentDate)}">
        Box score &amp; play-by-play
      </button>
      ${recap}
    </div>
  </article>`;
}

/* ------------------------------------------------------------------ */
/* game detail                                                         */
/* ------------------------------------------------------------------ */

async function renderGameView(id, date) {
  const content = $('#game-content');
  content.innerHTML = '<div class="notice"><span class="spinner"></span>Loading official game data…</div>';
  state.game = { id, date, game: null, box: null, pbp: null };

  const scorePayload = await fetchScore(date);
  const game = scorePayload?.games?.find((g) => String(g.id) === String(id)) || null;

  const [box, pbp] = await Promise.all([
    fetchOfficial(`/gamecenter/${id}/boxscore`, `box:${id}`),
    fetchOfficial(`/gamecenter/${id}/play-by-play`, `pbp:${id}`),
  ]);

  state.game = { id, date, game, box, pbp, scorePayload };
  describeTransport();

  if (!game && !box && !pbp) {
    content.innerHTML = `<div class="notice">
      This game could not be loaded right now.<br>
      <a class="btn" href="${NHL_BASE}/scores" target="_blank" rel="noopener">Open NHL.com Scores ↗</a>
      <button class="btn" onclick="location.hash='#/board'">Back to scoreboard</button>
    </div>`;
    return;
  }
  drawGameDetail();
}

function drawGameDetail() {
  const { game, box, pbp } = state.game;
  const head = box || pbp || game || {};
  const away = head.awayTeam || game?.awayTeam || {};
  const home = head.homeTeam || game?.homeTeam || {};
  const content = $('#game-content');

  const badge = game ? statusBadge(game) : { cls: 'final', text: '' };
  const live = isLiveGame(game || head);

  const ghScore = (team) => (team.score != null ? team.score : '–');
  const winnerCls = (t) => {
    if (!isFinalGame(game || head)) return '';
    if (away.score === home.score) return '';
    const won = t === away ? away.score > home.score : home.score > away.score;
    return won ? '' : ' style="opacity:.72"';
  };

  const links = [];
  if (game?.gameCenterLink || head.gameCenterLink) {
    links.push(`<a class="btn" href="${NHL_BASE}${esc(game?.gameCenterLink || head.gameCenterLink)}" target="_blank" rel="noopener">Official Game Center ↗</a>`);
  }
  if (game?.threeMinRecap) links.push(`<a class="btn" href="${NHL_BASE}${esc(game.threeMinRecap)}" target="_blank" rel="noopener">3-Minute Recap ↗</a>`);
  if (game?.condensedGame) links.push(`<a class="btn" href="${NHL_BASE}${esc(game.condensedGame)}" target="_blank" rel="noopener">Condensed Game ↗</a>`);
  links.push(`<button class="btn" onclick="location.hash='#/board/${esc(state.game.date || '')}'">← Back to scoreboard</button>`);

  const meta = [];
  if (head.gameDate || game?.gameDate) {
    meta.push(`<span>${esc(niceDateFmt.format(new Date((head.gameDate || game.gameDate) + 'T12:00:00')))}</span>`);
  }
  if (head.venue) meta.push(`<span>${esc(localized(head.venue))}${head.venueLocation ? ' · ' + esc(localized(head.venueLocation)) : ''}</span>`);
  const tv = (head.tvBroadcasts || game?.tvBroadcasts || []).map((b) => b.network).filter(Boolean);
  if (tv.length) meta.push(`<span>📺 ${esc(tv.slice(0, 4).join(', '))}</span>`);
  if (game?.seriesStatus) meta.push(`<span class="gc-series">${esc(seriesLine(game.seriesStatus))}</span>`);

  content.innerHTML = `
    <div class="game-header">
      <div class="gh-teams">
        <div class="gh-team"${winnerCls(away)}>
          <img src="${esc(away.logo || '')}" alt="">
          <div><b>${esc(away.abbrev || '')}</b><div class="rec">${esc(localized(away.commonName) || localized(away.name) || '')}</div></div>
          <div class="big-score">${ghScore(away)}</div>
        </div>
        <div class="gh-mid">
          <div class="gh-status${live ? ' live' : ''}">${badge.live ? '<span class="live-dot"></span> ' : ''}${badge.text || 'GAME'}</div>
          <div class="at">@ ${esc(home.abbrev || '')}</div>
        </div>
        <div class="gh-team"${winnerCls(home)}>
          <img src="${esc(home.logo || '')}" alt="">
          <div><b>${esc(home.abbrev || '')}</b><div class="rec">${esc(localized(home.commonName) || localized(home.name) || '')}</div></div>
          <div class="big-score">${ghScore(home)}</div>
        </div>
      </div>
      <div class="gh-meta">${meta.join('')}</div>
      <div class="gh-links">${links.join('')}</div>
    </div>
    <div id="detail-body"></div>`;

  const body = $('#detail-body');
  const nameMap = buildNameMap(box, pbp);

  let html = '<div class="detail-grid">';

  // ---- scoring summary (official, from the score payload when present) ----
  const goals = game?.goals?.length ? game.goals : [];
  if (goals.length) {
    html += `<div>
      <div class="section-title">Scoring summary <small style="text-transform:none;letter-spacing:0">(official)</small></div>
      <div class="goal-list">${goals.map((g) => goalRow(g, away, home)).join('')}</div>
    </div>`;
  }

  // ---- box score tables ----
  if (box) {
    html += `<div>${boxscoreHtml(box)}</div>`;
  } else if (game && !isFinalGame(game) && !live) {
    html += `<div><div class="notice">No box score published for this game yet.</div></div>`;
  } else if ((game && isFinalGame(game)) || pbp) {
    html += `<div><div class="notice">
      Full box score and play-by-play for this game aren't stored in the local archive
      (they're fetched live only for recent games). Everything above is official —
      and the complete record is always available at the
      <a href="${NHL_BASE}${esc(game?.gameCenterLink || head.gameCenterLink || '')}" target="_blank" rel="noopener">official NHL.com Game Center ↗</a>
      or the raw official APIs:
      <a href="${API_BASE}/gamecenter/${esc(state.game.id)}/play-by-play" target="_blank" rel="noopener">play-by-play JSON ↗</a> ·
      <a href="${API_BASE}/gamecenter/${esc(state.game.id)}/boxscore" target="_blank" rel="noopener">boxscore JSON ↗</a>.
    </div></div>`;
  }
  html += '</div>';

  // ---- play by play ----
  if (pbp && Array.isArray(pbp.plays)) {
    html += `
      <div class="section-title">Play-by-play <small style="text-transform:none;letter-spacing:0">(official feed)</small>
        <span class="spacer"></span>
        <span class="pbp-controls">
          <span class="chip-row" id="pbp-periods"></span>
          <select id="pbp-filter" aria-label="Filter events">
            <option value="all">All events</option>
            <option value="goal">Goals</option>
            <option value="penalty">Penalties</option>
            <option value="shots">Shots &amp; blocks</option>
            <option value="faceoff">Faceoffs</option>
          </select>
        </span>
      </div>
      ${pbp.limitedScoring ? '<div class="notice">Note: the NHL marks this game as “limited scoring” coverage.</div>' : ''}
      <div class="pbp-list" id="pbp-list"></div>`;
  }

  body.innerHTML = html;

  if (pbp && Array.isArray(pbp.plays)) {
    // Preserve the user's filters when the same game re-renders on live polls.
    if (state.game._renderedId !== String(state.game.id)) {
      state.game.pbpFilter = 'all';
      state.game.pbpPeriod = 'all';
    }
    state.game._renderedId = String(state.game.id);
    wirePbp(pbp, nameMap, away, home);
  }
}

function goalRow(g, away, home) {
  const first = localized(g.firstName);
  const last = localized(g.lastName);
  const assists = (g.assists || []).map((a) => localized(a.name)).filter(Boolean).join(', ');
  const strength = g.strength === 'pp' ? '<span class="strength-chip">PP</span>'
    : g.strength === 'sh' ? '<span class="strength-chip">SH</span>'
    : g.strength === 'en' ? '<span class="strength-chip">EN</span>' : '';
  const modifier = g.goalModifier && g.goalModifier !== 'none'
    ? `<span class="strength-chip">${esc(g.goalModifier.replace(/-/g, ' ').toUpperCase())}</span>` : '';
  const when = `${periodLabel(g.periodDescriptor)} ${g.timeInPeriod}`;
  return `<div class="goal-row">
    <div class="g-when">${esc(when)}</div>
    <img src="${esc(g.mugshot || '')}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
    <div class="g-main">
      <b>${esc(first)} ${esc(last)}</b> (${g.goalsToDate})${strength}${modifier}
      ${assists ? `<small>Assists: ${esc(assists)}</small>` : ''}
    </div>
    <div class="g-score">${esc(away.abbrev)} ${g.awayScore}–${g.homeScore} ${esc(home.abbrev)}</div>
  </div>`;
}

function buildNameMap(box, pbp) {
  const map = new Map();
  if (box?.playerByGameStats) {
    for (const side of ['awayTeam', 'homeTeam']) {
      const groups = box.playerByGameStats[side] || {};
      for (const groupKey of ['forwards', 'defense', 'goalies']) {
        for (const p of groups[groupKey] || []) {
          map.set(p.playerId, localized(p.name));
        }
      }
    }
  }
  // Older games (verified back to 1917) have no boxscore payload, but the
  // official play-by-play response carries a full rosterSpots array.
  for (const spot of pbp?.rosterSpots || []) {
    if (spot?.playerId != null && !map.has(spot.playerId)) {
      const first = localized(spot.firstName);
      const last = localized(spot.lastName);
      const full = [first, last].filter(Boolean).join(' ');
      if (full) map.set(spot.playerId, full);
    }
  }
  return map;
}

/** Player-name lookup, returned pre-escaped for safe innerHTML use. */
function nm(map, id) {
  if (id == null) return '';
  return esc(map.get(id) || `#${id}`);
}

function prettyKey(key) {
  return String(key || '').replace(/-/g, ' ');
}

function describePlay(p, map, awayAbbrev, homeAbbrev) {
  const d = p.details || {};
  switch (p.typeDescKey) {
    case 'goal': {
      const scorer = nm(map, d.scoringPlayerId);
      const a1 = d.assist1PlayerId ? nm(map, d.assist1PlayerId) : '';
      const a2 = d.assist2PlayerId ? nm(map, d.assist2PlayerId) : '';
      const assists = [a1, a2].filter(Boolean).join(', ');
      const shot = d.shotType ? ` (${esc(d.shotType)})` : '';
      const after = d.awayScore != null
        ? ` ${esc(awayAbbrev)} ${d.awayScore}–${d.homeScore} ${esc(homeAbbrev)}` : '';
      const total = d.scoringPlayerTotal ? ` (${d.scoringPlayerTotal})` : '';
      return `${scorer}${total} scores${shot}.${assists ? ' Assists: ' + assists + '.' : ''}${after}`;
    }
    case 'penalty': {
      const who = nm(map, d.committedByPlayerId ?? d.committingPlayerId ?? d.playerId);
      const mins = d.penaltyMinutes ? `${d.penaltyMinutes} min` : '';
      const reason = d.descKey ? esc(prettyKey(d.descKey)) : (d.reason ? esc(prettyKey(d.reason)) : '');
      const drew = d.drawnByPlayerId ? ` (drawn by ${nm(map, d.drawnByPlayerId)})` : '';
      return [who, reason, mins, drew].filter(Boolean).join(' ');
    }
    case 'shot-on-goal': {
      const shooter = nm(map, d.shootingPlayerId);
      return `${shooter}${d.shotType ? ' (' + esc(d.shotType) + ')' : ''} — shot on goal.`;
    }
    case 'missed-shot': {
      const shooter = nm(map, d.shootingPlayerId);
      return `${shooter} misses${d.shotType ? ' (' + esc(d.shotType) + ')' : ''}${d.reason ? ' — ' + esc(prettyKey(d.reason)) : ''}.`;
    }
    case 'blocked-shot': {
      return `${nm(map, d.blockingPlayerId)} blocks ${nm(map, d.shootingPlayerId)}${d.shotType ? ' (' + esc(d.shotType) + ')' : ''}.`;
    }
    case 'hit':
      return `${nm(map, d.hittingPlayerId)} hits ${nm(map, d.hitteePlayerId)}.`;
    case 'giveaway':
      return `${nm(map, d.playerId)} giveaway.`;
    case 'takeaway':
      return `${nm(map, d.playerId)} takeaway.`;
    case 'faceoff':
      return `${nm(map, d.winningPlayerId)} wins the faceoff vs ${nm(map, d.losingPlayerId)}.`;
    case 'stoppage':
      return d.reason ? `Stoppage — ${esc(prettyKey(d.reason))}.` : 'Stoppage.';
    case 'period-start':
      return `Start of ${periodLabel(p.periodDescriptor)} period.`;
    case 'period-end':
      return `End of ${periodLabel(p.periodDescriptor)} period.`;
    case 'shootout-shot':
    case 'shootout-shot-complete':
      return `${nm(map, d.scoringPlayerId ?? d.shootingPlayerId ?? d.playerId)} — shootout attempt${d.shotType ? ' (' + esc(d.shotType) + ')' : ''}.`;
    case 'goalie-in-net':
      return `${nm(map, d.playerId ?? d.goalieInNetId)} is in net.`;
    default:
      return esc(prettyKey(p.typeDescKey)) || 'Event';
  }
}

const SHOT_KEYS = new Set(['shot-on-goal', 'missed-shot', 'blocked-shot']);

function wirePbp(pbp, map, away, home) {
  const periods = [...new Set(pbp.plays.map((p) => p.periodDescriptor?.number).filter(Boolean))].sort((a, b) => a - b);
  // If a remembered period filter no longer exists in this feed, fall back.
  if (state.game.pbpPeriod !== 'all' && !periods.includes(Number(state.game.pbpPeriod))) {
    state.game.pbpPeriod = 'all';
  }
  const chipHost = $('#pbp-periods');
  chipHost.innerHTML =
    `<button class="chip${state.game.pbpPeriod === 'all' ? ' active' : ''}" data-period="all">All</button>` +
    periods.map((n) => {
      const pd = pbp.plays.find((p) => p.periodDescriptor?.number === n)?.periodDescriptor;
      const active = String(state.game.pbpPeriod) === String(n) ? ' active' : '';
      return `<button class="chip${active}" data-period="${n}">${periodLabel(pd)}</button>`;
    }).join('');

  const list = $('#pbp-list');

  const draw = () => {
    const filter = state.game.pbpFilter;
    const period = state.game.pbpPeriod;
    const rows = pbp.plays
      .filter((p) => {
        if (period !== 'all' && p.periodDescriptor?.number !== Number(period)) return false;
        const k = p.typeDescKey;
        if (filter === 'goal') return k === 'goal' || k === 'shootout-shot-complete';
        if (filter === 'penalty') return k === 'penalty';
        if (filter === 'shots') return SHOT_KEYS.has(k) || k === 'goal';
        if (filter === 'faceoff') return k === 'faceoff';
        return true;
      })
      .sort((a, b) => (b.sortOrder ?? 0) - (a.sortOrder ?? 0));

    if (!rows.length) {
      list.innerHTML = '<div class="notice">No events match this filter.</div>';
      return;
    }
    list.innerHTML = rows.map((p) => {
      const pd = p.periodDescriptor || {};
      const isGoal = p.typeDescKey === 'goal';
      const cls = isGoal ? ' goal' : (p.typeDescKey === 'penalty' ? ' penalty' : '');
      const label = isGoal ? 'GOAL' : (p.typeDescKey === 'penalty' ? 'PENALTY' : prettyKey(p.typeDescKey));
      return `<div class="pbp-row${cls}">
        <span class="p-time">${periodLabel(pd)} ${esc(p.timeInPeriod || '')}</span>
        <span class="p-type">${esc(label)}</span>
        <span>${describePlay(p, map, away?.abbrev || 'AWY', home?.abbrev || 'HOM')}</span>
      </div>`;
    }).join('');
  };

  chipHost.querySelectorAll('.chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      chipHost.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      state.game.pbpPeriod = chip.dataset.period;
      draw();
    });
  });
  const select = $('#pbp-filter');
  const validFilters = ['all', 'goal', 'penalty', 'shots', 'faceoff'];
  if (!validFilters.includes(state.game.pbpFilter)) state.game.pbpFilter = 'all';
  select.value = state.game.pbpFilter;
  select.addEventListener('change', (e) => {
    state.game.pbpFilter = e.target.value;
    draw();
  });
  draw();
}

function boxscoreHtml(box) {
  const sides = [];
  for (const sideKey of ['awayTeam', 'homeTeam']) {
    const team = sideKey === 'awayTeam' ? box.awayTeam : box.homeTeam;
    const stats = box.playerByGameStats?.[sideKey] || {};
    sides.push(boxTeamTable(team, stats));
  }
  return sides.join('');
}

function boxTeamTable(team, stats) {
  const skaters = [...(stats.forwards || []), ...(stats.defense || [])];
  const goalies = stats.goalies || [];
  const skRows = skaters.map((p) => `<tr>
      <td>${p.sweaterNumber ?? ''}</td>
      <td class="pname">${esc(localized(p.name))}</td>
      <td>${esc(p.position || '')}</td>
      <td>${p.goals ?? 0}</td><td>${p.assists ?? 0}</td><td>${p.points ?? 0}</td>
      <td>${p.plusMinus != null && p.plusMinus > 0 ? '+' + p.plusMinus : p.plusMinus ?? 0}</td>
      <td>${p.pim ?? 0}</td><td>${p.sog ?? 0}</td><td>${p.hits ?? 0}</td><td>${p.blockedShots ?? 0}</td>
      <td>${p.faceoffWinningPctg != null ? (p.faceoffWinningPctg * 100).toFixed(1) + '%' : '–'}</td>
      <td>${esc(p.toi || '–')}</td>
    </tr>`).join('');
  const gRows = goalies.map((p) => `<tr>
      <td>${p.sweaterNumber ?? ''}</td>
      <td class="pname">${esc(localized(p.name))}${p.decision ? ` <b>(${esc(p.decision)})</b>` : ''}</td>
      <td>${esc(p.saveShotsAgainst || `${p.saves ?? 0}/${p.shotsAgainst ?? 0}`)}</td>
      <td>${p.savePctg != null ? p.savePctg.toFixed(3).replace(/^0/, '') : '–'}</td>
      <td>${p.goalsAgainst ?? 0}</td>
      <td>${esc(p.toi || '–')}</td>
    </tr>`).join('');

  return `
    <div class="box-team-head">
      <img src="${esc(team.logo || '')}" alt="">
      ${esc(localized(team.commonName) || team.abbrev || '')}
      <small>${team.score != null ? team.score + ' goals · ' : ''}${team.sog != null ? team.sog + ' shots' : ''}</small>
    </div>
    <div class="table-wrap">
    <table class="box">
      <thead><tr><th>#</th><th style="text-align:left">Skater</th><th>POS</th><th>G</th><th>A</th><th>P</th><th>+/-</th><th>PIM</th><th>SOG</th><th>HITS</th><th>BLK</th><th>FO%</th><th>TOI</th></tr></thead>
      <tbody>${skRows}</tbody>
    </table>
    </div>
    <div class="table-wrap" style="margin-top:10px">
    <table class="box">
      <thead><tr><th>#</th><th style="text-align:left">Goalie</th><th>SV/SA</th><th>SV%</th><th>GA</th><th>TOI</th></tr></thead>
      <tbody>${gRows}</tbody>
    </table>
    </div>`;
}

/* ------------------------------------------------------------------ */
/* standings                                                           */
/* ------------------------------------------------------------------ */

async function renderStandings() {
  const content = $('#standings-content');
  content.innerHTML = '<div class="notice"><span class="spinner"></span>Loading official standings…</div>';

  const data = await fetchOfficial('/standings/now', 'standings');
  if (!data || !Array.isArray(data.standings)) {
    content.innerHTML = `<div class="notice">
      Could not load standings right now.
      <div><a class="btn" href="${NHL_BASE}/standings" target="_blank" rel="noopener">Open NHL.com Standings ↗</a></div>
    </div>`;
    return;
  }
  describeTransport();

  const asOf = data.standingsDateTimeUtc
    ? new Intl.DateTimeFormat(undefined, { dateStyle: 'long', timeStyle: 'short' }).format(new Date(data.standingsDateTimeUtc))
    : '';

  const confs = ['Eastern', 'Western'];
  let html = `<p class="verified-on">Official standings as of <strong>${esc(asOf)}</strong> ·
    source: <a href="https://api-web.nhle.com/v1/standings/now" rel="noopener">api-web.nhle.com/v1/standings/now</a> ·
    legend and clinch details on <a href="${NHL_BASE}/standings" rel="noopener">NHL.com</a></p>`;

  for (const conf of confs) {
    const teams = data.standings
      .filter((t) => t.conferenceName === conf)
      .sort((a, b) => a.conferenceSequence - b.conferenceSequence);
    if (!teams.length) continue;

    const rows = teams.map((t) => {
      const streak = t.streakCode ? `${t.streakCode}${t.streakCount || ''}` : '–';
      const clinch = t.clinchIndicator ? `<span class="clinch" title="Official clinch indicator">${esc(t.clinchIndicator)}</span>` : '';
      const wc = t.wildcardSequence > 0 ? '<span class="wc-flag" title="Wild card position">WC</span>' : '';
      const cut = t.conferenceSequence === 9 ? ' class="wc-cut"' : '';
      const diff = t.goalDifferential > 0 ? `+${t.goalDifferential}` : t.goalDifferential;
      return `<tr${cut}>
        <td class="rank">${t.conferenceSequence}</td>
        <td class="tname-cell">${esc(localized(t.teamName) || t.teamAbbrev?.default || '')}${clinch}${wc}<span class="div-chip">${esc(t.divisionAbbrev || '')}</span></td>
        <td>${t.gamesPlayed}</td><td>${t.wins}</td><td>${t.losses}</td><td>${t.otLosses}</td>
        <td><b>${t.points}</b></td>
        <td>${t.pointPctg != null ? t.pointPctg.toFixed(3).replace(/^0/, '') : '–'}</td>
        <td>${t.regulationWins}</td>
        <td>${diff}</td>
        <td>${esc(streak)}</td>
      </tr>`;
    }).join('');

    html += `<div class="std-conf-title">${esc(conf)} Conference</div>
      <div class="panel"><div class="table-wrap">
      <table class="std">
        <thead><tr><th>#</th><th style="text-align:left">Team</th><th>GP</th><th>W</th><th>L</th><th>OTL</th><th>PTS</th><th>P%</th><th>RW</th><th>DIFF</th><th>STRK</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      </div></div>`;
  }
  content.innerHTML = html;
}

/* ------------------------------------------------------------------ */
/* seasons browser                                                     */
/* ------------------------------------------------------------------ */

function lsGet(key) { try { return localStorage.getItem(key); } catch { return null; } }
function lsSet(key, value) { try { localStorage.setItem(key, value); } catch { /* private mode */ } }

async function loadTeamOptions() {
  const data = await fetchOfficial('/standings/now', 'standings');
  const rows = data?.standings;
  if (Array.isArray(rows) && rows.length) {
    return rows
      .map((t) => ({ abbrev: t.teamAbbrev?.default, name: localized(t.teamName) || t.teamAbbrev?.default }))
      .filter((t) => t.abbrev)
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }
  // Standings unavailable → fall back to the club list recorded in the manifest.
  return (manifest?.seasons?.teams || []).map((a) => ({ abbrev: a, name: a }));
}

async function renderSeasons(team, season) {
  const content = $('#seasons-content');
  content.innerHTML = '<div class="notice"><span class="spinner"></span>Loading the official season index…</div>';

  const currentSeason = manifest?.seasons?.current
    || seasonForDate(manifest?.currentDate || fmtDateInput(new Date()));
  if (!team) team = lsGet('nhl-season-team') || 'MTL';
  if (!season) season = currentSeason;
  lsSet('nhl-season-team', team);

  const teams = await loadTeamOptions();
  const seasons = seasonList(currentSeason);

  const teamOptions = teams.some((t) => t.abbrev === team)
    ? teams
    : [{ abbrev: team, name: team }, ...teams];
  const seasonOptsHtml = seasons
    .slice().reverse() // newest first in the dropdown
    .map((s) => `<option value="${s}"${s === season ? ' selected' : ''}>${seasonLabel(s)}${s === currentSeason ? ' (current)' : ''}</option>`)
    .join('');
  const teamOptsHtml = teamOptions
    .map((t) => `<option value="${esc(t.abbrev)}"${t.abbrev === team ? ' selected' : ''}>${esc(t.name)} (${esc(t.abbrev)})</option>`)
    .join('');

  content.innerHTML = `
    <div class="season-controls panel">
      <label>Team <select id="season-team" aria-label="Team">${teamOptsHtml}</select></label>
      <label>Season <select id="season-year" aria-label="Season">${seasonOptsHtml}</select></label>
      <span class="hint">Every NHL season since 1917-18 · 2004-05 was cancelled (no games)</span>
    </div>
    <div id="season-body"></div>`;

  $('#season-team').addEventListener('change', (e) => {
    location.hash = `#/season/${e.target.value}/${season}`;
  });
  $('#season-year').addEventListener('change', (e) => {
    location.hash = `#/season/${team}/${e.target.value}`;
  });

  const body = $('#season-body');
  const payload = await fetchOfficial(`/club-schedule-season/${team}/${season}`, `season:${team}:${season}`);
  if (!payload || !Array.isArray(payload.games)) {
    body.innerHTML = `<div class="notice">
      The official season index for <strong>${esc(team)} ${esc(seasonLabel(season))}</strong> isn't in the local
      snapshot, and the NHL API can't be read directly from the browser (no cross-origin permission),
      so it can't be loaded right now.<br>
      Review the official source directly:
      <a class="btn" href="${API_BASE}/club-schedule-season/${encodeURIComponent(team)}/${season}" target="_blank" rel="noopener">Raw official JSON ↗</a>
      <a class="btn" href="${NHL_BASE}/scores" target="_blank" rel="noopener">NHL.com Scores ↗</a>
    </div>`;
    setStatus('warn', 'Season index unavailable', 'Not in the local snapshot; direct fetch blocked by CORS.');
    return;
  }
  describeTransport();

  const games = payload.games;
  const rec = seasonRecord(games, team, season);
  const detailAvailable = (g) => Boolean(manifest?.files?.[`pbp:${g.id}`]);

  if (!games.length) {
    body.innerHTML = `<div class="notice">
      The official NHL records show <strong>no games for ${esc(team)} in ${esc(seasonLabel(season))}</strong>
      (clubs that had not yet joined the league — or historical abbreviations that differ from today's,
      e.g. the Hartford Whalers are <code>HFD</code>, not <code>CAR</code> — return an empty list).
      <div><a class="btn" href="${API_BASE}/club-schedule-season/${encodeURIComponent(team)}/${season}" target="_blank" rel="noopener">Verify at the official API ↗</a></div>
    </div>`;
    return;
  }

  const recordStrip = rec.gp
    ? `<div class="record-strip">
        <span><b>${rec.w}</b> W</span><span><b>${rec.l}</b> L</span>
        ${rec.t ? `<span><b>${rec.t}</b> T</span>` : ''}
        ${rec.otl ? `<span><b>${rec.otl}</b> OTL</span>` : ''}
        <span class="pts"><b>${rec.pts}</b> PTS</span>
        <span>GF <b>${rec.gf}</b></span><span>GA <b>${rec.ga}</b></span>
        <span class="hint">record computed from the official game results above</span>
      </div>`
    : '';

  // Newest first, grouped by month.
  const sorted = [...games].sort((a, b) => String(b.gameDate).localeCompare(String(a.gameDate)));
  const groups = [];
  let currentKey = null;
  for (const g of sorted) {
    const key = String(g.gameDate || '').slice(0, 7);
    if (key !== currentKey) { groups.push({ key, games: [] }); currentKey = key; }
    groups[groups.length - 1].games.push(g);
  }

  const monthTitle = (key) => {
    try {
      return new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' })
        .format(new Date(`${key}-15T12:00:00`));
    } catch { return key; }
  };

  body.innerHTML = `
    <p class="verified-on">Official ${esc(seasonLabel(season))} schedule &amp; results for ${esc(team)} ·
      source: <a href="${API_BASE}/club-schedule-season/${encodeURIComponent(team)}/${season}" rel="noopener">api-web.nhle.com/v1/club-schedule-season/${esc(team)}/${season}</a>
      ${payload.fetchedAt ? `· snapshot ${esc(payload.fetchedAt.replace('T', ' ').slice(0, 16))} UTC` : ''}</p>
    ${recordStrip}
    ${groups.map((grp) => `
      <div class="season-group">
        <div class="season-month">${esc(monthTitle(grp.key))}</div>
        ${grp.games.map((g) => seasonRow(g, team, detailAvailable(g))).join('')}
      </div>`).join('')}`;

  body.querySelectorAll('[data-open]').forEach((btn) => {
    btn.addEventListener('click', () => {
      location.hash = `#/game/${btn.dataset.open}/${btn.dataset.date || ''}`;
    });
  });
}

function seasonRow(g, teamAbbrev, detailAvailable) {
  const isHome = g.homeTeam?.abbrev === teamAbbrev;
  const opp = isHome ? g.awayTeam : g.homeTeam;
  const played = g.awayTeam?.score != null && g.homeTeam?.score != null;
  const result = played ? gameResultFor(g, teamAbbrev) : null;
  const date = new Date((g.gameDate || '') + 'T12:00:00');
  const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric' });
  const kind = g.gameType === 1 ? '<span class="badge kind">PRE</span>'
    : g.gameType === 3 ? '<span class="badge kind">PO</span>' : '';

  const middle = played
    ? `<span class="sr-score">${g.awayTeam.score}–${g.homeTeam.score}</span>`
    : `<span class="sr-time">${esc(fmtTime(g.startTimeUTC) || '')}</span>`;
  const chip = result
    ? `<span class="result-chip ${result.win ? 'win' : 'loss'}">${esc(result.label)}</span>`
    : '<span class="result-chip fut">—</span>';

  return `<div class="season-row${result ? ` ${result.win ? 'won' : 'lost'}` : ''}">
    <span class="sr-date">${esc(dayFmt.format(date))}</span>
    <span class="sr-opp"><img src="${esc(opp?.logo || '')}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
      ${isHome ? 'vs' : '@'} <b>${esc(opp?.abbrev || '')}</b> ${kind}</span>
    ${middle}
    ${chip}
    <span class="sr-links">
      <button class="btn btn-accent${detailAvailable ? '' : ' btn-ghost'}" data-open="${g.id}" data-date="${esc(g.gameDate || '')}">Game detail</button>
      <a class="btn" href="${NHL_BASE}${esc(g.gameCenterLink || '')}" target="_blank" rel="noopener" title="Verify on the official NHL.com Game Center">NHL.com ↗</a>
    </span>
  </div>`;
}

/* ------------------------------------------------------------------ */
/* live refresh loop                                                   */
/* ------------------------------------------------------------------ */

async function silentBoardRefresh() {
  if (!state.boardDate) return;
  const payload = await fetchScore(state.boardDate);
  if (!payload) return;
  state.boardPayload = payload;
  renderWeekStrip(payload);
  const games = payload.games || [];
  const sorted = [...games].sort((a, b) => {
    const la = isLiveGame(a) ? 0 : 1;
    const lb = isLiveGame(b) ? 0 : 1;
    if (la !== lb) return la - lb;
    return String(a.startTimeUTC).localeCompare(String(b.startTimeUTC));
  });
  const content = $('#board-content');
  content.innerHTML = sorted.map((g) => gameCard(g, payload)).join('');
  // Card buttons are bound by the MutationObserver on #board-content.
}

async function silentGameRefresh() {
  const { id, date } = state.game || {};
  if (!id) return;
  const scorePayload = await fetchScore(date);
  const game = scorePayload?.games?.find((g) => String(g.id) === String(id)) || state.game.game;
  const fetches = [];
  if (isLiveGame(game) || !state.game.pbp) {
    fetches.push(fetchOfficial(`/gamecenter/${id}/play-by-play`, `pbp:${id}`).then((r) => { if (r) state.game.pbp = r; }));
  }
  if (isLiveGame(game) || !state.game.box) {
    fetches.push(fetchOfficial(`/gamecenter/${id}/boxscore`, `box:${id}`).then((r) => { if (r) state.game.box = r; }));
  }
  await Promise.all(fetches);
  state.game.game = game;
  state.game.scorePayload = scorePayload || state.game.scorePayload;
  describeTransport();
  drawGameDetail();
}

async function tick() {
  if (document.hidden) return;
  const before = manifest?.generatedAt || null;
  await loadManifest();
  const changed = manifest?.generatedAt !== before;

  if (state.view === 'board') {
    const hasLive = (state.boardPayload?.games || []).some(isLiveGame);
    if (hasLive || changed) await silentBoardRefresh();
  } else if (state.view === 'game' && state.game?.id) {
    const live = isLiveGame(state.game.game);
    if (live || changed) await silentGameRefresh();
  }
  describeTransport();
}

function startPolling() {
  clearInterval(state.pollTimer);
  state.pollTimer = setInterval(tick, POLL_MS);
}

/* ------------------------------------------------------------------ */
/* wiring                                                              */
/* ------------------------------------------------------------------ */

function bindCardButtons(root = document) {
  root.querySelectorAll('[data-open]').forEach((btn) => {
    btn.addEventListener('click', () => {
      location.hash = `#/game/${btn.dataset.open}/${btn.dataset.date || ''}`;
    });
  });
}

// Re-bind after every board render (innerHTML replaces nodes).
const observer = new MutationObserver(() => bindCardButtons($('#board-content')));
observer.observe($('#board-content'), { childList: true });

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    location.hash = tab.dataset.view === 'board' ? '#/board' : `#/${tab.dataset.view}`;
  });
});

$('#brand').addEventListener('click', () => { location.hash = '#/board'; });
$('#brand').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') location.hash = '#/board';
});

function gotoBoardDate(date) {
  if (!date) return;
  const target = `#/board/${date}`;
  if (location.hash === target) route(); // already there → force a refresh
  else location.hash = target;
}

$('#today-btn').addEventListener('click', async () => {
  await loadManifest();
  gotoBoardDate(manifest?.currentDate || fmtDateInput(new Date()));
});

$('#prev-day').addEventListener('click', () => {
  gotoBoardDate(state.boardPayload?.prevDate || shiftDate(state.boardDate, -1));
});
$('#next-day').addEventListener('click', () => {
  gotoBoardDate(state.boardPayload?.nextDate || shiftDate(state.boardDate, 1));
});
$('#date-input').addEventListener('change', (e) => {
  if (e.target.value) location.hash = `#/board/${e.target.value}`;
});
$('#refresh-btn').addEventListener('click', async () => {
  await loadManifest();
  route();
});

function shiftDate(iso, deltaDays) {
  if (!iso) return null;
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return fmtDateInput(d);
}

/* ------------------------------------------------------------------ */
/* boot                                                                */
/* ------------------------------------------------------------------ */

(async function init() {
  await loadManifest();
  if (manifest) {
    $('#date-input').value = manifest.currentDate;
  } else {
    $('#date-input').value = fmtDateInput(new Date());
    setStatus('warn', 'No local snapshot — fetching the official NHL API on demand',
      'The scheduled data job has not produced a snapshot yet; using live requests.');
  }
  route();
  startPolling();
})();
