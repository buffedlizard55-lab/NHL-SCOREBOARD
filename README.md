# NHL Scoreboard

A clean, user-friendly scoreboard for **every NHL game** — live scores, official play-by-play,
box scores, standings, and **full game history** (verified back to at least the 2009–10 season).
All data comes **directly from the NHL's own official public API** — no manual entry, no invented
numbers, no third-party statistics.

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

---

## ✅ What exists today

| Capability | Status | Source of truth |
|---|---|---|
| Today's scoreboard (preseason/regular/playoffs) | ✅ live | `GET /v1/score/now` |
| Any historical date (verified to 2009-10) | ✅ live | `GET /v1/score/{YYYY-MM-DD}` |
| Full official play-by-play for any game | ✅ live | `GET /v1/gamecenter/{id}/play-by-play` |
| Full box score (skaters + goalies) for any game | ✅ live | `GET /v1/gamecenter/{id}/boxscore` |
| Standings | ✅ live | `GET /v1/standings/now` |
| Automatic live refresh | ✅ every ~5 min (see limitations) | scheduled GitHub Actions snapshot |
| Official verification links on every game card | ✅ | each card links to its NHL.com Game Center page |

The GitHub Pages site itself is the deliverable: clean dark UI, three tabs
(**Scores / Standings / About & Sources**), date navigation with the NHL's own week strip,
game detail pages with scoring summary, box-score tables and a filterable play-by-play feed,
and a status bar that always tells you exactly where the data came from.

---

## 📡 Verified official data sources

Every endpoint below was **exercised and its response inspected line-by-line on 2026-09-25**.
Click through to review the raw JSON yourself.

| Official endpoint | Purpose | Verification evidence (2026-09-25) |
|---|---|---|
| [`api-web.nhle.com/v1/score/now`](https://api-web.nhle.com/v1/score/now) | Current scoreboard; redirects to `/v1/score/{currentDate}` | Returned focus date `2026-09-25`, 11 games that day, full week strip |
| [`api-web.nhle.com/v1/score/{date}`](https://api-web.nhle.com/v1/score/2026-09-25) | All games + official scoring summary for any date | Verified `2026-09-25`, `2026-06-14`, `2019-02-07`, `2010-01-15` |
| [`api-web.nhle.com/v1/gamecenter/{id}/play-by-play`](https://api-web.nhle.com/v1/gamecenter/2025030416/play-by-play) | Complete play-by-play event feed | Verified for game `2025030416` (2026 SCF G6), `2026010027`, `2018020823` (2019) |
| [`api-web.nhle.com/v1/gamecenter/{id}/boxscore`](https://api-web.nhle.com/v1/gamecenter/2025030416/boxscore) | Per-game skater/goalie stats | Verified for `2026010027` and `2018020823` |
| [`api-web.nhle.com/v1/standings/now`](https://api-web.nhle.com/v1/standings/now) | Standings (32 teams, clinch indicators) | Returned final 2025-26 standings (`date: 2026-04-17`) |
| [`api.nhle.com/stats/rest/en/skater/summary`](https://api.nhle.com/stats/rest/en/skater/summary?cayenneExp=seasonId%3D20252026&limit=2&sort=%5B%7B%22property%22%3A%22points%22%2C%22direction%22%3A%22DESC%22%7D%5D&start=0) | Historical stats REST API (supplemental) | Returned 2025-26 scoring leaders |
| [`nhl.com/scores`](https://www.nhl.com/scores) · [`nhl.com/standings`](https://www.nhl.com/standings) | Official human-readable pages | Linked from every card/row for manual cross-checking |

**Sample cross-checked facts from those responses (not written by hand):**
Game 6 of the 2026 Stanley Cup Final — Carolina Hurricanes 3, Vegas Golden Knights 0,
2026-06-14 at T-Mobile Arena (game id `2025030416`), series `CAR 4–2 VGK`; scorers
T. Hall (03:47 P1), J. Blake (13:31 P2), N. Ehlers empty-netter (18:52 P3).

### Reproduce the verification yourself

```bash
curl -s "https://api-web.nhle.com/v1/score/now" | head -c 400
curl -s "https://api-web.nhle.com/v1/score/2026-06-14"      # 2026 Stanley Cup Final clincher
curl -s "https://api-web.nhle.com/v1/gamecenter/2025030416/play-by-play" | head -c 400
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

1. `tools/build-site.mjs` fetches the **official** scoreboard (`/v1/score/now`), the surrounding
   week, previous day, standings, and play-by-play + box score for every non-future game in that
   window — directly from `api-web.nhle.com`, server-side.
2. The responses are written verbatim into `data/*.json` and committed to `main` when changed;
   GitHub Pages (serving this branch, `.nojekyll`) republishes automatically. The browser never
   has to trust us: payloads are the API's own JSON, and every game links to NHL.com.
3. For games outside the snapshot window (any historical game), the browser asks the NHL API
   directly; because the NHL API sends **no CORS headers** (verified below), static sites fall
   back to transparent pass-through transports — the status bar always shows which path was used,
   and every game page links to the official Game Center for manual review.
4. Failure-safe: the snapshot is built in a staging directory and swapped in only on success.
   If the official scoreboard can't be fetched, nothing is committed and the **previous snapshot
   stays live** — the site never serves a broken or fabricated page.

### Why the snapshot design (verified constraint, not preference)

Raw HTTP header inspection of `https://api-web.nhle.com/v1/score/now` on **2026-09-25** shows
`200 OK`, `Content-Type: application/json`, Cloudflare caching (`max-age=19`) — and **no
`Access-Control-Allow-Origin` header**. Same for `api.nhle.com/stats/rest`. Browsers therefore
refuse to let any static site (including GitHub Pages) read those responses directly. Fetching
official data server-side in the deploy pipeline is the most reliable CORS-free design.

---

## 🗂 Repository layout

GitHub Pages serves the **main branch root** (with `.nojekyll`), so the site files live at the
top level:

```
index.html                App shell + About/Sources tab content
styles.css                Clean dark UI
app.js                    Scoreboard, game detail, standings, transport layer, live polling
data/                     Official NHL JSON snapshots (committed by the scheduled workflow)
tools/
  build-site.mjs          Server-side fetch of official NHL data (Node 20, no deps)
  fixture-server.mjs      Local mock of the API shape (tests only)
  test-build.mjs          End-to-end test of the snapshot pipeline
  test-app.mjs            Unit tests for the app's core logic
.github/workflows/
  deploy.yml              every-5-minutes + manual → fetch official data → commit if changed
```

### Local development & tests

```bash
node tools/test-build.mjs   # builds against a local fixture of the official API shape
node tools/test-app.mjs     # unit-tests app.js logic in a stubbed browser context
```

---

## 🚩 Flagged irregularities & limitations (for review)

1. **`api.nhle.com/stats/rest/en/score/scores` returns HTTP 404** (Jetty error page) as of
   2026-09-25 while other reports on the same host (`skater/summary`, `team`) work. Historical
   coverage here therefore uses `/v1/score/{date}` instead (which works back to at least 2009-10).
2. **No CORS on either official API** (verified via raw headers). Direct browser fetch is
   attempted first (future-proof), then pass-through transports; both public relays tested
   2026-09-25 (`allorigins`, `codetabs`) were returning errors that day, which is precisely why
   the snapshot path is the primary design.
3. **Legacy `statsapi.web.nhl.com` is dead** (DNS no longer resolves — community-reported and
   confirmed by failed connection in this repo's research pass). Nothing here depends on it.
4. **Live cadence ≈ 5 minutes**, the finest cron GitHub Actions allows. The official feed itself
   updates within seconds; closing this gap would require a push/WebSocket source or a small
   server — see roadmap. Also: Pages rebuilds from the branch have a documented soft limit of
   ~10 builds/hour, so on heavy game days a publish can lag its commit slightly; off-season the
   data barely changes, so almost no builds are triggered.
5. **GitHub disables cron workflows after 60 days of repo inactivity.** If the snapshot stops
   refreshing, re-enable the workflow from the Actions tab (one click). Also note GitHub can
   delay cron runs during Actions peak load, and newly added schedules may take a while before
   their first run; any push to main (including data commits) never harms freshness because
   push-triggered runs use the exact same job.
6. **Preseason included.** The official feed currently serves 2026-27 preseason games
   (`gameType: 1`); the site labels them `PRE`. Standings show the last completed season
   (official behavior between seasons).

---

## 🗺 Roadmap — what to build next session

- **Season browser:** jump straight to any season's full schedule/results (loop `/v1/score/{date}`
  across a season window and cache season indexes as static JSON).
- **Playoff bracket view** from `seriesStatus` / playoff-series endpoints.
- **Team pages** (`/v1/roster/{team}/current`, `/v1/club-stats/{team}/now` — verify before use).
- **Closer-to-realtime option:** evaluate NHL.com's WebSocket/`diffPatch` feed to beat the
  5-minute cron floor (must remain official-source-only).
- **PWA install + notifications** for game start/goals.
- **Integration test against the live API** run daily from CI, with header assertions, so any
  endpoint change or CORS change is caught automatically.

---

*Unofficial fan project. All game data, team names and logos are the property of the National
Hockey League and are fetched from its official public endpoints. Not affiliated with or
endorsed by the NHL. For official records always use [nhl.com](https://www.nhl.com).*
