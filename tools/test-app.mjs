#!/usr/bin/env node
/**
 * Smoke test for app.js — evaluates the real file in a stubbed browser
 * context and exercises the core logic (states, labels, play descriptions,
 * name resolution). No external network.
 *
 *   node tools/test-app.mjs
 */
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const src = readFileSync(path.join(ROOT, 'app.js'), 'utf8');

function makeEl(extra = {}) {
  return {
    innerHTML: '', textContent: '', value: '', hidden: false,
    className: '', title: '', dataset: {},
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {}, setAttribute() {},
    querySelectorAll: () => [], querySelector: () => null,
    appendChild() {}, ...extra,
  };
}

const els = {};
const documentStub = {
  hidden: false,
  querySelector: (sel) => (els[sel] ||= makeEl()),
  querySelectorAll: () => [],
};

const context = vm.createContext({
  console,
  document: documentStub,
  window: { addEventListener() {} },
  location: { hash: '', assign(h) { this.hash = h; } },
  fetch: async () => { throw new TypeError('network disabled in test'); },
  MutationObserver: class { observe() {} },
  setInterval: () => 0, // don't keep the process alive
  clearInterval() {},
  setTimeout, clearTimeout,
  Intl, Date, JSON, Map, Set, Promise, Object, Array, String, Number, Boolean, RegExp, Error,
});

vm.runInContext(src, context, { filename: 'app.js' });

// wait for the async init() IIFE to settle
await new Promise((r) => setTimeout(r, 50));

let failed = 0;
const check = (cond, label) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failed += 1;
};

const g = (name) => vm.runInContext(name, context);

/* period labels */
check(g(`periodLabel({number:1,periodType:'REG'})`) === '1st', 'periodLabel 1st');
check(g(`periodLabel({number:3,periodType:'REG'})`) === '3rd', 'periodLabel 3rd');
check(g(`periodLabel({number:4,periodType:'OT'})`) === 'OT', 'periodLabel OT');
check(g(`periodLabel({number:6,periodType:'OT'})`) === '3OT', 'periodLabel 3OT');
check(g(`periodLabel({number:5,periodType:'SO'})`) === 'SO', 'periodLabel SO');
check(g(`periodLabel(null)`) === '', 'periodLabel null-safe');

/* status badges */
check(g(`statusBadge({gameState:'FUT',startTimeUTC:'2026-09-25T23:00:00Z',periodDescriptor:{number:3,periodType:'REG'}})`).cls === 'upcoming', 'statusBadge FUT');
check(g(`statusBadge({gameState:'LIVE',clock:{timeRemaining:'12:34',inIntermission:false},periodDescriptor:{number:2,periodType:'REG'}})`).text.includes('LIVE'), 'statusBadge LIVE');
check(g(`statusBadge({gameState:'CRIT',clock:{inIntermission:true},periodDescriptor:{number:2,periodType:'REG'}})`).text.includes('Intermission'), 'statusBadge intermission');
check(g(`statusBadge({gameState:'FINAL',periodDescriptor:{number:4,periodType:'OT'}})`).text === 'FINAL/OT', 'statusBadge FINAL/OT');
check(g(`statusBadge({gameState:'OFF',periodDescriptor:{number:5,periodType:'SO'}})`).text === 'FINAL/SO', 'statusBadge FINAL/SO');
check(g(`statusBadge({gameState:'OFF',periodDescriptor:{number:3,periodType:'REG'}})`).text === 'FINAL', 'statusBadge FINAL reg');
check(g(`statusBadge({gameState:'FUT',gameScheduleState:'PPD',startTimeUTC:'2026-09-25T23:00:00Z'})`).text === 'POSTPONED', 'statusBadge PPD');

/* series line */
check(g(`seriesLine({seriesTitle:'Stanley Cup Final',gameNumberOfSeries:6,topSeedTeamAbbrev:'CAR',topSeedWins:4,bottomSeedTeamAbbrev:'VGK',bottomSeedWins:2})`)
  === 'Stanley Cup Final · Game 6 · CAR lead 4–2', 'seriesLine lead');
check(g(`seriesLine({seriesTitle:'SCF',gameNumberOfSeries:3,topSeedTeamAbbrev:'CAR',topSeedWins:1,bottomSeedTeamAbbrev:'VGK',bottomSeedWins:1})`)
  .includes('tied'), 'seriesLine tied');

/* play descriptions with name map */
const boxFixture = {
  playerByGameStats: {
    awayTeam: { forwards: [{ playerId: 11, name: { default: 'A. Player' } }], defense: [], goalies: [] },
    homeTeam: { forwards: [{ playerId: 22, name: { default: 'B. Rival' } }], defense: [], goalies: [{ playerId: 33, name: { default: 'G. Tender' } }] },
  },
};
check(g(`buildNameMap(${JSON.stringify(boxFixture).replace(/"/g, "'").replace(/'/g, '"')}).size`) === 3, 'buildNameMap size');
const mapExpr = `buildNameMap(${JSON.stringify(boxFixture)})`;
const goalDesc = g(`describePlay({typeDescKey:'goal',details:{scoringPlayerId:11,scoringPlayerTotal:5,assist1PlayerId:22,shotType:'slap',awayScore:1,homeScore:0}}, ${mapExpr}, 'AWY','HOM')`);
check(goalDesc.includes('A. Player (5) scores (slap).') && goalDesc.includes('Assists: B. Rival.') && goalDesc.includes('AWY 1–0 HOM'), 'describe goal scorer');
check(g(`describePlay({typeDescKey:'penalty',details:{committedByPlayerId:22,drawnByPlayerId:11,penaltyMinutes:2,descKey:'tripping'}}, ${mapExpr}, 'AWY','HOM')`).includes('tripping'), 'describe penalty');
check(g(`describePlay({typeDescKey:'hit',details:{hittingPlayerId:11,hitteePlayerId:22}}, ${mapExpr}, 'AWY','HOM')`) === 'A. Player hits B. Rival.', 'describe hit');
check(g(`describePlay({typeDescKey:'unknown-future-event',details:{}}, ${mapExpr}, 'AWY','HOM')`) === 'unknown future event', 'describe unknown key pretty-prints (no invention)');

/* isLive/isFinal guards */
check(g(`isLiveGame({gameState:'CRIT'})`) === true, 'isLiveGame CRIT');
check(g(`isFinalGame({gameState:'OFF'})`) === true, 'isFinalGame OFF');
check(g(`isLiveGame(null)`) === false, 'isLiveGame null-safe');

/* season utilities */
check(g(`seasonForDate('2026-09-25')`) === 20262027, 'seasonForDate September (preseason of next season)');
check(g(`seasonForDate('2026-06-14')`) === 20252026, 'seasonForDate June (playoffs of prior season)');
check(g(`seasonForDate('2026-01-01')`) === 20252026, 'seasonForDate January');
check(g(`seasonForDate('2025-07-01')`) === 20252026, 'seasonForDate July 1 rollover');
check(g(`seasonForDate('')`) === null, 'seasonForDate null-safe');
check(g(`seasonLabel(20252026)`) === '2025-26', 'seasonLabel');
check(g(`seasonLabel(19171918)`) === '1917-18', 'seasonLabel first season');

const sl = g(`seasonList(20262027)`);
check(sl[0] === 19171918, 'seasonList starts at the first NHL season 1917-18');
check(sl[sl.length - 1] === 20262027, 'seasonList ends at the current season');
check(!sl.includes(20042005), 'seasonList excludes the cancelled 2004-05 season');
check(sl.length === 109, `seasonList count 1917-18..2026-27 minus 2004-05 (got ${sl.length})`);

/* game results from a club's perspective */
const mkGame = (awayAbbr, awayScore, homeAbbr, homeScore, lastPeriodType = 'REG', extra = {}) => ({
  awayTeam: { abbrev: awayAbbr, score: awayScore },
  homeTeam: { abbrev: homeAbbr, score: homeScore },
  gameOutcome: { lastPeriodType },
  ...extra,
});
check(g(`gameResultFor(${JSON.stringify(mkGame('BOS', 2, 'BUF', 3))}, 'BUF')`).code === 'W', 'gameResultFor regulation win');
check(g(`gameResultFor(${JSON.stringify(mkGame('BUF', 2, 'BOS', 3))}, 'BUF')`).code === 'L', 'gameResultFor regulation loss');
const otGame = mkGame('BOS', 1, 'BUF', 2, 'OT');
check(g(`gameResultFor(${JSON.stringify(otGame)}, 'BUF')`).label === 'W-OT', 'gameResultFor OT win label');
check(g(`gameResultFor(${JSON.stringify(otGame)}, 'BOS')`).code === 'OTL', 'gameResultFor OT loss code');
check(g(`gameResultFor(${JSON.stringify(mkGame('BUF', 2, 'BOS', 1, 'SO'))}, 'BUF')`).label === 'W-SO', 'gameResultFor SO win label');
check(g(`gameResultFor(${JSON.stringify(mkGame('BUF', 1, 'BOS', 2, 'SO'))}, 'BUF')`).code === 'OTL', 'gameResultFor SO loss counts as OTL');
check(g(`gameResultFor(${JSON.stringify(mkGame('BUF', 1, 'BOS', 1))}, 'BUF')`).code === 'T', 'gameResultFor tie (pre-2005 era)');
check(g(`gameResultFor(${JSON.stringify({ awayTeam: { abbrev: 'BUF' }, homeTeam: { abbrev: 'BOS' }, gameOutcome: { lastPeriodType: 'REG' } })}, 'BUF')`) === null, 'gameResultFor unplayed game is null');

/* season records (points follow the rules of the era) */
const seasonGames = [
  mkGame('BOS', 2, 'BUF', 3),          // W
  mkGame('BUF', 2, 'BOS', 3),          // L
  mkGame('BUF', 1, 'BOS', 2, 'OT'),    // OTL
  mkGame('BOS', 1, 'BUF', 1),          // T
  mkGame('COL', 4, 'BUF', 1),          // L
  { awayTeam: { abbrev: 'BUF' }, homeTeam: { abbrev: 'COL' }, gameOutcome: { lastPeriodType: 'REG' } }, // FUT — ignored
];
const recModern = g(`seasonRecord(${JSON.stringify(seasonGames)}, 'BUF', 20252026)`);
check(recModern.w === 1 && recModern.l === 2 && recModern.otl === 1 && recModern.t === 1, 'seasonRecord counts W/L/OTL/T');
check(recModern.pts === 4, `seasonRecord modern points 2W+OTL+T (got ${recModern.pts})`);
check(recModern.gf === 8 && recModern.ga === 12 && recModern.gp === 5, 'seasonRecord goals for/against');
const recOld = g(`seasonRecord(${JSON.stringify(seasonGames)}, 'BUF', 19851986)`);
check(recOld.pts === 3, `seasonRecord pre-1999 OTL is worth 0 (got ${recOld.pts})`);

/* rosterSpots fallback for old games (verified: official pbp carries rosters back to 1917) */
const pbpFixture = {
  rosterSpots: [
    { playerId: 8447594, firstName: { default: 'Joe' }, lastName: { default: 'Malone' } },
    { playerId: 8450137, firstName: { default: 'Georges' }, lastName: { default: 'Vezina' } },
  ],
};
check(g(`buildNameMap(null, ${JSON.stringify(pbpFixture)}).size`) === 2, 'buildNameMap falls back to pbp rosterSpots');
check(g(`buildNameMap(null, ${JSON.stringify(pbpFixture)}).get(8447594)`) === 'Joe Malone', 'buildNameMap rosterSpots full name');
const mixedMap = g(`buildNameMap(${JSON.stringify(boxFixture)}, ${JSON.stringify(pbpFixture)})`);
check(mixedMap.size === 5 && mixedMap.get(8447594) === 'Joe Malone' && mixedMap.get(11) === 'A. Player',
  'buildNameMap merges boxscore first, rosterSpots fills gaps');

/* escaping */
check(g(`esc('<script>&"\\'')`) === '&lt;script&gt;&amp;&quot;&#39;', 'esc escapes html');

/* integration: manifest -> snapshot/archive lookup path (no network) */
const intManifest = {
  generatedAt: '2026-09-25T12:00:00.000Z',
  currentDate: '2026-09-25',
  seasons: { current: 20262027, previous: 20252026, teams: ['BOS', 'BUF', 'COL'] },
  files: {
    'score:2026-09-19': 'data/archive/score-2026-09-19.json',
    'season:BUF:20262027': 'data/seasons/20262027/BUF.json',
  },
};
const mkIntGame = (awayAbbr, awayScore, homeAbbr, homeScore) => ({
  id: 1, gameDate: '2026-09-19', gameState: 'OFF', gameScheduleState: 'OK',
  awayTeam: { abbrev: awayAbbr, score: awayScore },
  homeTeam: { abbrev: homeAbbr, score: homeScore },
  gameOutcome: { lastPeriodType: 'REG' },
});
const intFiles = {
  'data/archive/score-2026-09-19.json': {
    projectedFrom: 'https://api-web.nhle.com/v1/score/2026-09-19',
    fetchedAt: '2026-09-25T11:00:00.000Z',
    date: '2026-09-19', currentDate: '2026-09-19', complete: true,
    prevDate: '2026-09-18', nextDate: '2026-09-20',
    gameWeek: [{ date: '2026-09-19', dayAbbrev: 'SAT', numberOfGames: 1 }],
    games: [mkIntGame('BOS', 2, 'BUF', 3)],
  },
  'data/seasons/20262027/BUF.json': {
    projectedFrom: 'https://api-web.nhle.com/v1/club-schedule-season/BUF/20262027',
    fetchedAt: '2026-09-25T11:00:00.000Z',
    season: 20262027, team: 'BUF',
    games: [
      mkIntGame('BOS', 2, 'BUF', 3),
      { id: 9, gameDate: '2026-09-26', gameState: 'FUT', gameScheduleState: 'OK', awayTeam: { abbrev: 'BUF' }, homeTeam: { abbrev: 'COL' }, gameOutcome: { lastPeriodType: 'REG' } },
    ],
  },
};
vm.runInContext(`manifest = ${JSON.stringify(intManifest)}`, context);
context.fetch = async (url) => {
  const p = String(url).split('?')[0];
  const body = intFiles[p];
  if (!body) throw new TypeError('404 in test fixture');
  return { ok: true, json: async () => body };
};
const archivedDay = await vm.runInContext(`fetchScore('2026-09-19')`, context);
check(archivedDay && archivedDay.currentDate === '2026-09-19'
  && Array.isArray(archivedDay.games) && archivedDay.games.length === 1
  && archivedDay.games[0].homeTeam.abbrev === 'BUF',
  'fetchScore resolves an archived date via the manifest');
check(await vm.runInContext(`lastTransport`, context) === 'snapshot', 'archived date used the snapshot transport');
const seasonPayload = await vm.runInContext(`fetchOfficial('/club-schedule-season/BUF/20262027', 'season:BUF:20262027')`, context);
check(seasonPayload && seasonPayload.team === 'BUF' && seasonPayload.games.length === 2,
  'fetchOfficial resolves a club-season index via the manifest');
context.fetch = async () => { throw new TypeError('network disabled in test'); };
vm.runInContext('manifest = null', context);

console.log(failed === 0 ? '\nALL APP TESTS PASSED' : `\n${failed} TEST(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
