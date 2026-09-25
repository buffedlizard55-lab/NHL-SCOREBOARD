# NHL Scoreboard

A clean, user-friendly scoreboard for **every NHL game** — live scores, official play-by-play,
box scores, standings, **full-season browsing for all 32 clubs**, and **game history verified all
the way back to the league's first game on December 19, 1917**. All data comes **directly from the
NHL's own official public API** — no manual entry, no invented numbers, no third-party statistics.

**Live site:** <https://buffedlizard55-lab.github.io/NHL-SCOREBOARD/>
*(GitHub Actions rebuilds it with a fresh official data snapshot every 5 minutes.)*

![deploy workflow](https://github.com/buffedlizard55-lab/NHL-SCOREBOARD/actions/workflows/deploy.yml/badge.svg)

---

## 🧭 North-star prompt (re-read this every session)

> Let's work on reverse engineering the NHL site and rebuilding a scoreboard for all games and
> historical games as well. I want real verified official live play by play game data from the
> official governing league, NHL. The play by play game data and all statistics should come
> directly from the NHL site. [NHL.com](http://NHL.com)
>
> It should solve the problem of having to manually check everything ourselves and having an
> up to date current feed.
>
> Work line by line verifying from official verified trusted sources, provide links for manual
> review. There should be no manual input, work on your own to complete tasks. Flag any
> irregularities for review. **No hallucinations. Verify no hallucinations.**
>
> The goal of this project is to get a full list that follows our requirements. Verify line by line.
>
> **Site creation:** create a GitHub Page for this repo that has a clean UI, is user friendly,
> simple and easy to use. It should be organized and clean. It should include all relevant
> information in an easy to read format with official verified links as sources for review.

### Core values guiding every change (per the Arena AI team)

- **Maximize P(Win):** in every decision we weigh tradeoffs, assess risk, and choose the path
  that maximizes the probability the project succeeds — no emotions, no shortcuts that create
  correctness risk.
- **Own the Outcome:** we own results end to end. When problems arise and we can act, we act
  without waiting for permission. Failure and success are signals we use to improve. We stay
  accountable to the final outcome.

### Working method (every session)

1. Re-read the north-star prompt above.
2. Verify every claim against the **live official endpoints** — line by line, first-hand, with
   links left in this README for manual review.
3. Run the task in **multiple passes**: implement → review for bugs/edge cases → re-check against
   the original request; each pass builds on the previous one.
4. Flag irregularities; never guess. Anything not verified against the official source gets
   labeled as such or removed.

---

## ✅ What exists today

| Capability | Status | Source of truth |
|---|---|---|
| Today's scoreboard (preseason/regular/playoffs) | ✅ live | `GET /v1/score/now` |
| Any historical date (verified back to **1917-12-19**) | ✅ live | `GET /v1/score/{YYYY-MM-DD}` |
| Full official play-by-play for any game | ✅ live | `GET /v1/gamecenter/{id}/play-by-play` |
| Full box score (skaters + goalies) for any game | ✅ live | `GET /v1/gamecenter/{id}/boxscore` |
| **Season browser: every game of all 32 clubs, current + previous season** | ✅ live | `GET /v1/club-schedule-season/{team}/{season}` |
| **Historical score archive (scores + official scoring summaries)** | ✅ live | `GET /v1/score/{date}` (projected snapshot) |
| Standings | ✅ live | `GET /v1/standings/now` |
| Automatic live refresh | ✅ every ~5 min (see limitations) | scheduled GitHub Actions snapshot |
| Official verification links on every game card | ✅ | each card links to its NHL.com Game Center page |

The GitHub Pages site itself is the deliverable: clean dark UI, four tabs
(**Scores / Seasons / Standings / About & Sources**), date navigation with the NHL's own week strip,
game detail pages with scoring summary, box-score tables and a filterable play-by-play feed,
a season browser with per-club records computed from official results, and a status bar that
always tells you exactly where the data came from.

---

## 📡 Verified official data sources

Every endpoint below was **exercised and its response inspected line-by-line** —
pass 1 on 2026-09-25, and re-verified (including the new historical endpoints) in pass 2 the same
day. Click through to review the raw JSON yourself.

| Official endpoint | Purpose | Verification evidence (2026-09-25) |
|---|---|---|
| [`api-web.nhle.com/v1/score/now`](https://api-web.nhle.com/v1/score/now) | Current scoreboard; redirects to `/v1/score/{currentDate}` | Returned focus date `2026-09-25` (preseason, 2026-27 season) |
| [`api-web.nhle.com/v1/score/{date}`](https://api-web.nhle.com/v1/score/2026-09-25) | All games + official scoring summary for any date | Verified `2026-09-25`, `2026-06-14`, `2010-01-15`, **`1917-12-19`** (league opener, Joe Malone's 5-goal game) |
| [`api-web.nhle.com/v1/gamecenter/{id}/play-by-play`](https://api-web.nhle.com/v1/gamecenter/2025030416/play-by-play) | Complete play-by-play event feed | Verified for `2025030416` (2026 SCF G6), `2026010027`, `2018020823` (2019), **`1917020001`** (first NHL game; includes full `rosterSpots`) |
| [`api-web.nhle.com/v1/gamecenter/{id}/boxscore`](https://api-web.nhle.com/v1/gamecenter/2025030416/boxscore) | Per-game skater/goalie stats | Verified for `2026010027` and `2018020823` (CAR 6 @ BUF 5 OT, 2019-02-07) |
| [`api-web.nhle.com/v1/standings/now`](https://api-web.nhle.com/v1/standings/now) | Standings (32 teams, clinch indicators) | Returned final 2025-26 standings (`date: 2026-04-17`) |
| [`api-web.nhle.com/v1/club-schedule-season/{team}/{season}`](https://api-web.nhle.com/v1/club-schedule-season/TOR/20252026) | **Every game of a club's season** | Verified TOR 2025-26 (full season), MTL **1917-18** (founding season), HFD 1985-86 (Whalers — defunct clubs under historical abbrevs), CAR 1985-86 (empty list — correct, Hurricanes didn't exist), **2004-05 → HTTP 404** (correct, season cancelled) |
| [`api-web.nhle.com/v1/standings/{date}`](https://api-web.nhle.com/v1/standings/1918-01-15) | Standings on any historical date | Verified `1918-01-15`: 4-team 1917-18 table (MTL/TAN/SEN/MWN) |
| [`api.nhle.com/stats/rest/en/skater/summary`](https://api.nhle.com/stats/rest/en/skater/summary?cayenneExp=seasonId%3D20252026&limit=2&sort=%5B%7B%22property%22%3A%22points%22%2C%22direction%22%3A%22DESC%22%7D%5D&start=0) | Historical stats REST API (supplemental) | Returned 2025-26 scoring leaders |
| [`nhl.com/scores`](https://www.nhl.com/scores) · [`nhl.com/standings`](https://www.nhl.com/standings) | Official human-readable pages | Linked from every card/row for manual cross-checking |

**Sample cross-checked facts from those responses (not written by hand):**
Game 6 of the 2026 Stanley Cup Final — Carolina Hurricanes 3, Vegas Golden Knights 0,
2026-06-14 at T-Mobile Arena (game id `2025030416`), series `CAR 4–2 VGK`; scorers
T. Hall (03:47 P1), J. Blake (13:31 P2), N. Ehlers empty-netter (18:52 P3).
First game in NHL history — 1917-12-19, Montreal Canadiens 7 @ Ottawa Senators 4
(game id `1917020001`), Joe Malone 5 goals (first goal 06:30 P1), Newsy Lalonde and Didier Pitre
also scoring, Georges Vezina in net — all present in the official feed.

### Reproduce the verification yourself

```bash
curl -s "https://api-web.nhle.com/v1/score/now" | head -c 400
curl -s "https://api-web.nhle.com/v1/score/2026-06-14"      # 2026 Stanley Cup Final clincher
curl -s "https://api-web.nhle.com/v1/score/1917-12-19"      # first game in NHL history
curl -s "https://api-web.nhle.com/v1/gamecenter/1917020001/play-by-play" | head -c 400
curl -s "https://api-web.nhle.com/v1/club-schedule-season/MTL/19171918" | head -c 400
curl -s "https://api-web.nhle.com/v1/standings/now" | head -c 400
```

---

## 🏗 How it works (architecture)

```
 ┌──────────────────────────────┐   every 5 min    ┌────────────────────────────┐
 │ GitHub Actions (deploy.yml)  │ ───────────────▶ │ Official NHL API           │
 │  node tools/build-site.mjs   │ ◀─────────────── │ api-web.nhle.com/v1 (NHL)  │
 └──────────────┬───────────────┘   official JSON  └────────────────────────────┘
                │ commits fresh data/*.json to main (only when changed)
                ▼
  GitHub Pages serves main branch (nojekyll)  ──▶  your browser renders locally
```

The build (Node 20, zero dependencies) runs in phases, building into a staging directory that is
swapped in atomically only on success — a failed run never wipes the live snapshot:

1. **Live window (verbatim).** `/score/now`, the whole week strip, the previous date, standings,
   and play-by-play + boxscore for every played game on the focus and previous dates. These files
   are byte-for-byte the official responses.
2. **Season indexes (projected).** `club-schedule-season` for every club in the official
   standings, current + previous season. Each file is a projection of the official response —
   every field copied unchanged, only irrelevant fields (betting odds, ticket links) dropped —
   and records its exact official source URL and fetch time. Current season refreshes on a 6-hour
   TTL; completed seasons are immutable and copied forward untouched.
3. **Score archive (projected).** Every completed date from those seasons (back to the start of
   the previous season) gets a projected `/score/{date}` file with scores and the full official
   scoring summaries, so historical game pages work with zero third parties. Immutable once all
   games on the date are final; backfill is capped at 60 dates per run and fully resumable.

The browser prefers these snapshots, then tries the official API directly, then public
pass-through transports; the status bar always shows which path was used, and every game page
links to the official Game Center for manual review.

### Why the snapshot design (verified constraint, not preference)

Raw HTTP header inspection of `https://api-web.nhle.com/v1/score/now` on **2026-09-25** shows
`200 OK`, `Content-Type: application/json`, Cloudflare caching (`max-age=19`) — and **no
`Access-Control-Allow-Origin` header**. Same for `api.nhle.com/stats/rest`. Browsers therefore
refuse to let any static site (including GitHub Pages) read those responses directly. On top of
that, **both public pass-through relays were re-checked on 2026-09-25 and were down**
(allorigins → HTTP 520, codetabs → HTTP 522), which is exactly why anything the site must show
reliably is fetched server-side into the snapshot.

---

## 🗂 Repository layout

GitHub Pages serves the **main branch root** (with `.nojekyll`), so the site files live at the
top level:

```
index.html                App shell + About/Sources tab content
styles.css                Clean dark UI
app.js                    Scoreboard, game detail, seasons, standings, transports, live polling
data/                     Official NHL JSON snapshots (committed by the scheduled workflow)
  score-{date}.json         verbatim live-week scoreboards
  games/{id}-*.json         verbatim play-by-play + boxscore (live window)
  standings-now.json        verbatim standings
  seasons/{S}/{TEAM}.json   projected club-season indexes
  archive/score-{date}.json projected historical scoreboards
  manifest.json             what exists, where it came from, when it was fetched
tools/
  build-site.mjs          Server-side fetch of official NHL data (Node 20, no deps)
  fixture-server.mjs      Local mock of the API shape (tests only)
  test-build.mjs          End-to-end test of the snapshot pipeline (incl. TTL reuse)
  test-app.mjs            Unit tests for the app's core logic
  test-ui.mjs             Optional jsdom click-through of the real app (skips w/o jsdom)
.github/workflows/
  deploy.yml              every-5-minutes + manual → fetch official data → commit if changed
```

### Local development & tests

```bash
node tools/test-build.mjs   # builds against a local fixture of the official API shape
node tools/test-app.mjs     # unit-tests app.js logic in a stubbed browser context
node tools/test-ui.mjs      # optional: boots the real app in jsdom and clicks every view
                            # (skips itself when jsdom isn't installed: `npm i jsdom`)
```

---

## 🚩 Flagged irregularities & limitations (for review)

1. **`api.nhle.com/stats/rest/en/score/scores` returns HTTP 404** (Jetty error page) as of
   2026-09-25 while other reports on the same host (`skater/summary`, `team`) work. Historical
   coverage therefore uses `/v1/score/{date}` instead.
2. **No CORS on either official API** (verified via raw headers). Direct browser fetch is
   attempted first (future-proof), then pass-through transports; both public relays tested
   2026-09-25 were **down** (520/522), which is precisely why the snapshot path is the primary
   design. The site states plainly when something could not be loaded and links the official
   source.
3. **Live cadence ≈ 5 minutes**, the finest cron GitHub Actions allows. The official feed itself
   updates within seconds; closing this gap would require a push/WebSocket source or a small
   server — see roadmap. Also: Pages rebuilds from the branch have a documented soft limit of
   ~10 builds/hour, so on heavy game days a publish can lag its commit slightly.
4. **Archive depth = current + previous season today.** Deeper history is browsable by date
   (the official API serves every date back to 1917-12-19), but beyond the archive those pages
   depend on the (currently dead) transports — every affected page shows the official links
   instead. The archive grows automatically as seasons roll over; deeper backfill is a roadmap
   item.
5. **Season browser covers today's 32 franchises.** The official API serves defunct/relocated
   clubs under their **historical** abbreviations (verified: Whalers are `HFD`, not `CAR` —
   `CAR/19851986` correctly returns an empty list), so older franchise eras need a historical
   club picker (roadmap). Any date in history remains reachable from the Scores tab.
6. **Dates with no club games** (e.g., All-Star weekend events) are not discovered by the
   club-schedule-driven archive; those specific dates fall back to transports/official links.
7. **GitHub disables cron workflows after 60 days of repo inactivity.** If the snapshot stops
   refreshing, re-enable the workflow from the Actions tab (one click). **Flagged 2026-09-25
   (session 2):** the freshly created `*/5` schedule produced **zero** scheduled runs for ~3 hours
   while push-triggered runs worked fine — a known GitHub behavior for newly created schedules
   (recognition can take 15 min to 1 h+, sometimes longer; see the Actions tab → filter
   `event:schedule`). Mitigations applied: a manual-run path that always works, and a cron change
   (`3-58/5`, avoiding the congested top-of-hour slot) to force schedule re-registration. If the
   feed ever looks stale, check the Actions tab first, then edit the cron or run the workflow
   manually — the push-triggered job is identical.
8. **Repo growth is bounded but real:** the archive adds roughly 1-2 MB per season (immutable,
   committed once). The current season's index files refresh every ~6 hours while games change
   state. If history grows beyond a few hundred MB some day, squash or move older seasons to
   external storage (roadmap).
9. **Preseason included.** The official feed serves 2026-27 preseason games (`gameType: 1`);
   the site labels them `PRE`. Standings show the last completed season (official behavior
   between seasons).
10. **Sandbox verification note (transparency):** the raw-header CORS check above was performed
    from this project's research environment; today's re-verification pass reached the endpoints
    through a platform fetch tool (which does not expose headers), and the endpoint *responses*
    were all re-verified that way. No claim in this README rests on unverified data.

---

## 🗺 Roadmap — what to build next session

- ✅ ~~**Season browser**~~ — shipped (current + previous season, all 32 clubs).
- **Deeper archive backfill:** extend the archive past the previous season (e.g., a one-time
  per-season backfill run, oldest→newest, still capped and resumable). ~1-2 MB per season.
- **Historical club picker:** defunct franchises (`HFD`, `SEN`, `MWN`, `ATL`, `PHX`, `QUE`, …)
  under their historical abbreviations, so Whalers/Nordikers/Original-Six eras are browsable
  season-by-season too.
- **Playoff bracket view** from `seriesStatus` / playoff-series endpoints.
- **Team pages** (`/v1/roster/{team}/current`, `/v1/club-stats/{team}/now` — verify before use).
- **Closer-to-realtime option:** evaluate NHL.com's WebSocket/`diffPatch` feed to beat the
  5-minute cron floor, or a tiny always-on pass-through worker (must remain official-source-only).
- **PWA install + notifications** for game start/goals.
- **Integration test against the live API** run daily from CI, with header assertions, so any
  endpoint change or CORS change is caught automatically.

---

*Unofficial fan project. All game data, team names and logos are the property of the National
Hockey League and are fetched from its official public endpoints. Not affiliated with or
endorsed by the NHL. For official records always use [nhl.com](https://www.nhl.com).*
