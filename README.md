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
update the two secrets (step 2.4 below). No code change is needed.

## 2. Deploy for free on Cloudflare Pages

1. Create a free account at <https://dash.cloudflare.com>.
2. **Workers & Pages** → **Create** → **Pages** → **Connect to Git**, and pick
   this GitHub repository.
3. Build settings:
   - Framework preset: **None**
   - Build command: *(leave empty)*
   - Build output directory: `public`
4. **Settings** → **Variables and Secrets** → add (type **Secret** for the
   first two):
   | Name | Value |
   |---|---|
   | `ESPN_S2` | your `espn_s2` cookie |
   | `ESPN_SWID` | your `SWID` cookie |
   | `LEAGUE_ID` | `58300197` (optional, this is the default) |
   | `SEASON` | `2026` (optional, this is the default; change it next season) |
5. Redeploy (Deployments → ⋯ → Retry deployment) so the secrets take effect.
6. Share the `https://<project>.pages.dev` URL with the league.

Every push to the production branch redeploys automatically. Cloudflare's free
plan allows 100,000 function requests a day, far more than a league needs.

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
