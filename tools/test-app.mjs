#!/usr/bin/env node
/**
 * Smoke test for docs/app.js — evaluates the real file in a stubbed browser
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

/* escaping */
check(g(`esc('<script>&"\\'')`) === '&lt;script&gt;&amp;&quot;&#39;', 'esc escapes html');

console.log(failed === 0 ? '\nALL APP TESTS PASSED' : `\n${failed} TEST(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
