# Sleepyhead Scoreboard

A one-screen, mobile-first scoreboard for an ESPN fantasy football league. One
row per team with a sortable index, standing, record, live points and ESPN's
projected total for the week. It follows the device's light/dark setting.

- `public/`: the page (plain HTML/CSS/JS, no build step)
- `functions/api/scoreboard.js`: Cloudflare Pages Function that calls ESPN with
  your login cookies and caches the result for 20 seconds, so many people
  pressing Refresh at once only causes one ESPN request
- `lib/espn.js`: ESPN fetch and data mapping
- `test/`: tests (`npm test`) with a made-up sample league

## 1. Get your ESPN cookies

The league is private, so the server needs two cookies from a browser that is
logged into ESPN. **They act like a password. Never commit them or share them.**

1. On a computer, log in at <https://fantasy.espn.com> and open your league.
2. Open developer tools (F12, or right-click → Inspect).
   - Chrome/Edge: **Application** tab → **Cookies** → `https://fantasy.espn.com`
   - Firefox: **Storage** tab → **Cookies**
   - Safari: enable the Develop menu, then **Storage** → **Cookies**
3. Copy the values of `espn_s2` (long string) and `SWID` (looks like
   `{XXXXXXXX-XXXX-...}`).

The cookies usually last about a year. Logging out of ESPN can end them early.
If the scoreboard says "ESPN rejected the login", repeat these steps and
update the two secrets (step 2.3 below). No code change is needed.

## 2. Deploy for free on Cloudflare

The repo works either as a Cloudflare **Worker** (Cloudflare's current
default; uses `wrangler.jsonc` and `src/worker.js`) or as a **Pages** project
(uses `functions/`, output directory `public`, no build command).

1. In the Cloudflare dashboard: **Compute (Workers)** → **Workers & Pages** →
   **Create** → import this GitHub repository. Accept the defaults
   (deploy command `npx wrangler deploy`).
2. The Worker's name should be `sleepyhead-scoreboard`, the same as `name`
   in `wrangler.jsonc`. If you chose another name, change that line to match.
3. Open the Worker → **Settings** → **Variables and Secrets** → add `ESPN_S2`
   and `ESPN_SWID` as type **Secret**. Optional plain-text variables:
   `LEAGUE_ID` (default `58300197`) and `SEASON` (default `2026`).
4. Push a commit or retry the latest deployment, then open the
   `https://…workers.dev` link from the Worker's overview page.

### Checking that it works

Open `https://<your-site>/api/scoreboard`:

| You see | Meaning |
|---|---|
| JSON starting `{"leagueName":…,"teams":[…` | Working |
| `"code":"auth"` | ESPN rejected the cookies; re-copy them |
| `"code":"not_found"` | Wrong `LEAGUE_ID` or `SEASON` |
| `"code":"network"` | ESPN unreachable; try again later |
| A 404 or Cloudflare error page | The function isn't deployed; check the build log |

Every push to the production branch redeploys automatically. Cloudflare's free
plan allows 100,000 requests a day, far more than a league needs.

## Run locally

Requires Node 18+.

```sh
npm test                 # run tests
npm run dev              # http://localhost:8788 with made-up sample data
ESPN_S2='…' ESPN_SWID='{…}' npm run dev   # same, with your real league
```

When sample data is shown, the header says "Sample data".

## How the data maps

One request to
`lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/{SEASON}/segments/0/leagues/{LEAGUE_ID}`
with views `mTeam`, `mMatchupScore`, `mScoreboard`, `mSettings`, `mStatus`:

| Column | ESPN field |
|---|---|
| Team | `teams[].name` (or `location` + `nickname`), `logo` |
| Standing | `teams[].playoffSeed` |
| Record | `teams[].record.overall` (sorted by win %) |
| Points | the team's own side of this week's `schedule[]` entry: `totalPointsLive` |
| Proj | same entry: `totalProjectedPointsLive` |

Opponents are never shown. Each team's score is read from its own side of the
schedule entry only.
