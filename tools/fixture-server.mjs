#!/usr/bin/env node
/**
 * Fixture server for tools/test-build.mjs — mimics the SHAPE of the official
 * api-web.nhle.com responses (shapes verified against real payloads on
 * 2026-09-25). Internal only; never deployed.
 */
import { createServer } from 'node:http';

const PORT = Number(process.env.NHL_TEST_PORT || 8791);

const gameFinal = {
  id: 2026010027, season: 20262027, gameType: 1, gameDate: '2026-09-25',
  venue: { default: 'Madison Square Garden' },
  startTimeUTC: '2026-09-25T23:00:00Z', easternUTCOffset: '-04:00', venueUTCOffset: '-04:00',
  tvBroadcasts: [{ id: 409, market: 'A', countryCode: 'US', network: 'MSGSN', sequenceNumber: 411 }],
  gameState: 'FINAL', gameScheduleState: 'OK',
  awayTeam: { id: 2, name: { default: 'New York Islanders' }, commonName: { default: 'Islanders' }, abbrev: 'NYI', score: 4, sog: 28, logo: 'https://assets.nhle.com/logos/nhl/svg/NYI_light.svg' },
  homeTeam: { id: 3, name: { default: 'New York Rangers' }, commonName: { default: 'Rangers' }, abbrev: 'NYR', score: 3, sog: 19, logo: 'https://assets.nhle.com/logos/nhl/svg/NYR_light.svg' },
  period: 3, periodDescriptor: { number: 3, periodType: 'REG', maxRegulationPeriods: 3 },
  gameCenterLink: '/gamecenter/nyi-vs-nyr/2026/09/25/2026010027',
  threeMinRecap: '/video/nyi-at-nyr-recap-123',
  goals: [{
    period: 1, periodDescriptor: { number: 1, periodType: 'REG', maxRegulationPeriods: 3 },
    timeInPeriod: '04:04', playerId: 8475753,
    name: { default: 'J. Faulk' }, firstName: { default: 'Justin' }, lastName: { default: 'Faulk' },
    goalModifier: 'none', assists: [{ playerId: 1, name: { default: 'S. Aho' }, assistsToDate: 37 }],
    mugshot: 'https://assets.nhle.com/mugs/nhl/20262027/NYI/8475753.png', teamAbbrev: 'NYI',
    goalsToDate: 5, awayScore: 1, homeScore: 0, strength: 'ev',
  }],
};

const gameFut = {
  id: 2026010049, season: 20262027, gameType: 1, gameDate: '2026-09-25',
  venue: { default: 'Capital One Arena' }, startTimeUTC: '2026-09-26T00:00:00Z',
  gameState: 'FUT', gameScheduleState: 'OK',
  awayTeam: { id: 6, name: { default: 'Bruins' }, abbrev: 'BOS', record: '45-27-10', logo: 'https://assets.nhle.com/logos/nhl/svg/BOS_light.svg' },
  homeTeam: { id: 15, name: { default: 'Capitals' }, abbrev: 'WSH', record: '43-30-9', logo: 'https://assets.nhle.com/logos/nhl/svg/WSH_light.svg' },
  gameCenterLink: '/gamecenter/bos-vs-wsh/2026/09/25/2026010049', venueTimezone: 'US/Eastern',
};

const gameYesterday = { ...gameFinal, id: 2026010024, gameDate: '2026-09-24', gameState: 'OFF' };

const scoreNow = {
  prevDate: '2026-09-24', currentDate: '2026-09-25', nextDate: '2026-09-26',
  gameWeek: [
    { date: '2026-09-22', dayAbbrev: 'TUE', numberOfGames: 10 },
    { date: '2026-09-23', dayAbbrev: 'WED', numberOfGames: 4 },
    { date: '2026-09-24', dayAbbrev: 'THU', numberOfGames: 11 },
    { date: '2026-09-25', dayAbbrev: 'FRI', numberOfGames: 2 },
    { date: '2026-09-26', dayAbbrev: 'SAT', numberOfGames: 14 },
    { date: '2026-09-27', dayAbbrev: 'SUN', numberOfGames: 0 },
    { date: '2026-09-28', dayAbbrev: 'MON', numberOfGames: 0 },
  ],
  oddsPartners: [],
  games: [gameFinal, gameFut],
};

const scorePrev = { ...scoreNow, currentDate: '2026-09-24', prevDate: '2026-09-22', nextDate: '2026-09-25', games: [gameYesterday] };
const emptyDay = { ...scoreNow, games: [] };

const standings = {
  standingsDateTimeUtc: '2026-09-25T18:59:00Z',
  standings: [
    { conferenceName: 'Eastern', conferenceSequence: 1, divisionAbbrev: 'A', divisionName: 'Atlantic', wildcardSequence: 0, clinchIndicator: 'p', teamName: { default: 'Buffalo Sabres' }, teamAbbrev: { default: 'BUF' }, teamLogo: '', gamesPlayed: 82, wins: 50, losses: 23, otLosses: 9, points: 109, pointPctg: 0.664634, regulationWins: 42, goalDifferential: 47, streakCode: 'W', streakCount: 3 },
    { conferenceName: 'Eastern', conferenceSequence: 2, divisionAbbrev: 'A', divisionName: 'Atlantic', wildcardSequence: 0, teamName: { default: 'Boston Bruins' }, teamAbbrev: { default: 'BOS' }, teamLogo: '', gamesPlayed: 82, wins: 45, losses: 27, otLosses: 10, points: 100, pointPctg: 0.609756, regulationWins: 40, goalDifferential: 20, streakCode: 'L', streakCount: 1 },
    { conferenceName: 'Western', conferenceSequence: 1, divisionAbbrev: 'C', divisionName: 'Central', wildcardSequence: 0, clinchIndicator: 'z', teamName: { default: 'Colorado Avalanche' }, teamAbbrev: { default: 'COL' }, teamLogo: '', gamesPlayed: 82, wins: 55, losses: 16, otLosses: 11, points: 121, pointPctg: 0.737805, regulationWins: 48, goalDifferential: 99, streakCode: 'W', streakCount: 3 },
  ],
};

const pbp = {
  id: 2026010027, season: 20262027, gameType: 1, gameState: 'FINAL',
  awayTeam: gameFinal.awayTeam, homeTeam: gameFinal.homeTeam,
  plays: [
    { eventId: 1, periodDescriptor: { number: 1, periodType: 'REG', maxRegulationPeriods: 3 }, timeInPeriod: '00:00', typeDescKey: 'period-start', sortOrder: 8, details: {} },
    { eventId: 2, periodDescriptor: { number: 1, periodType: 'REG', maxRegulationPeriods: 3 }, timeInPeriod: '04:04', typeDescKey: 'goal', sortOrder: 36, details: { scoringPlayerId: 8475753, scoringPlayerTotal: 5, assist1PlayerId: 8478427, shotType: 'slap', awayScore: 1, homeScore: 0, eventOwnerTeamId: 2 } },
    { eventId: 3, periodDescriptor: { number: 1, periodType: 'REG', maxRegulationPeriods: 3 }, timeInPeriod: '05:00', typeDescKey: 'penalty', sortOrder: 40, details: { committedByPlayerId: 8477500, drawnByPlayerId: 8475753, penaltyMinutes: 2, descKey: 'tripping' } },
    { eventId: 4, periodDescriptor: { number: 2, periodType: 'REG', maxRegulationPeriods: 3 }, timeInPeriod: '01:00', typeDescKey: 'hit', sortOrder: 60, details: { hittingPlayerId: 8475753, hitteePlayerId: 8477500 } },
  ],
};

const boxscore = {
  id: 2026010027, season: 20262027, gameState: 'FINAL',
  awayTeam: gameFinal.awayTeam, homeTeam: gameFinal.homeTeam,
  playerByGameStats: {
    awayTeam: {
      forwards: [{ playerId: 8475753, sweaterNumber: 27, name: { default: 'J. Faulk' }, position: 'D', goals: 1, assists: 0, points: 1, plusMinus: 1, pim: 0, hits: 1, powerPlayGoals: 0, sog: 2, toi: '24:23', blockedShots: 1, shifts: 28, giveaways: 0, takeaways: 0 }],
      defense: [],
      goalies: [{ playerId: 8470147, sweaterNumber: 35, name: { default: 'C. McElhinney' }, position: 'G', saveShotsAgainst: '34/39', savePctg: 0.871795, goalsAgainst: 5, toi: '63:25', decision: 'W', shotsAgainst: 39, saves: 34 }],
    },
    homeTeam: { forwards: [], defense: [], goalies: [] },
  },
};

const routes = {
  '/v1/score/now': scoreNow,
  '/v1/score/2026-09-25': scoreNow,
  '/v1/score/2026-09-24': scorePrev,
  '/v1/score/2026-09-22': emptyDay,
  '/v1/score/2026-09-23': emptyDay,
  '/v1/score/2026-09-26': emptyDay,
  '/v1/score/2026-09-27': emptyDay,
  '/v1/score/2026-09-28': emptyDay,
  '/v1/standings/now': standings,
  '/v1/gamecenter/2026010027/play-by-play': pbp,
  '/v1/gamecenter/2026010027/boxscore': boxscore,
  '/v1/gamecenter/2026010024/play-by-play': { ...pbp, id: 2026010024 },
  '/v1/gamecenter/2026010024/boxscore': { ...boxscore, id: 2026010024 },
};

createServer((req, res) => {
  const url = req.url.split('?')[0];
  const body = routes[url];
  if (!body) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found', url }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}).listen(PORT, '127.0.0.1', () => {
  console.log('READY');
});
