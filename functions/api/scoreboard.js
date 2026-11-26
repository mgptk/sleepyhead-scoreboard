// Cloudflare Pages Function: GET /api/scoreboard
//
// Required secrets (Pages project → Settings → Variables and Secrets):
//   ESPN_S2    – the espn_s2 cookie from a logged-in browser
//   ESPN_SWID  – the SWID cookie (with or without curly braces)
// Optional variables:
//   LEAGUE_ID  – defaults to 58300197
//   SEASON     – defaults to 2026
//
// Responses are cached for CACHE_SECONDS so that many people pressing Refresh
// at once only cause one request to ESPN.

import {
  fetchLeague,
  buildScoreboard,
  EspnError,
  ROSTER_VIEWS,
  fetchNflGames,
  gameStates,
  hasRosters,
  buildActivePlayers,
} from "../../lib/espn.js";

const CACHE_SECONDS = 20;
const DEFAULT_LEAGUE_ID = "58300197";
const DEFAULT_SEASON = "2026";

// Per-isolate memory cache plus in-flight request sharing. Backed up by the
// Cloudflare Cache API, which is shared across isolates in a data center.
let memo = null; // { key, expires, body }
let inflight = null; // { key, promise }

function json(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

async function load(env) {
  const creds = {
    leagueId: env.LEAGUE_ID || DEFAULT_LEAGUE_ID,
    season: env.SEASON || DEFAULT_SEASON,
    espnS2: env.ESPN_S2,
    swid: env.ESPN_SWID,
  };
  const raw = await fetchLeague(creds);
  const data = buildScoreboard(raw);

  // Active players. A failure here never breaks the scoreboard itself.
  try {
    const week = data.week;
    const scoringPeriodId = raw.scoringPeriodId;
    const [rosterRaw, nflRaw] = await Promise.all([
      hasRosters(raw, week)
        ? raw
        : fetchLeague({ ...creds, views: ROSTER_VIEWS, scoringPeriodId, matchupPeriodId: week }),
      fetchNflGames(),
    ]);
    data.activePlayers = buildActivePlayers(
      rosterRaw,
      data.teams,
      gameStates(nflRaw),
      rosterRaw.scoringPeriodId ?? scoringPeriodId,
      week
    );
  } catch {
    data.activePlayers = null;
    data.playersError = "Live player data is unavailable right now. Try refreshing in a moment.";
  }
  data.fetchedAt = new Date().toISOString();
  return JSON.stringify(data);
}

export async function onRequestGet({ request, env, waitUntil }) {
  const leagueId = env.LEAGUE_ID || DEFAULT_LEAGUE_ID;
  const season = env.SEASON || DEFAULT_SEASON;
  const key = `${leagueId}:${season}`;
  const now = Date.now();

  if (memo && memo.key === key && memo.expires > now) return json(memo.body);

  const cache = typeof caches !== "undefined" ? caches.default : null;
  const cacheKey = new Request(new URL(`/__espn-cache/${key}`, request.url).toString());
  if (cache) {
    try {
      const hit = await cache.match(cacheKey);
      if (hit) {
        const body = await hit.text();
        memo = { key, expires: now + CACHE_SECONDS * 1000, body };
        return json(body);
      }
    } catch {
      /* cache unavailable; fall through */
    }
  }

  try {
    if (!inflight || inflight.key !== key) {
      inflight = { key, promise: load(env) };
      inflight.promise.finally(() => {
        if (inflight && inflight.key === key) inflight = null;
      }).catch(() => {});
    }
    const body = await inflight.promise;
    memo = { key, expires: Date.now() + CACHE_SECONDS * 1000, body };
    if (cache) {
      const put = cache
        .put(cacheKey, new Response(body, { headers: { "Cache-Control": `max-age=${CACHE_SECONDS}` } }))
        .catch(() => {});
      if (waitUntil) waitUntil(put);
    }
    return json(body);
  } catch (err) {
    const e = err instanceof EspnError ? err : new EspnError("Something went wrong loading scores.");
    return json(JSON.stringify({ error: e.message, code: e.code, diagnostics: e.diagnostics }), e.status);
  }
}
