// Cloudflare Pages Function: GET /api/scoreboard
//
// Required secrets (Pages project → Settings → Variables and Secrets):
//   ESPN_S2    – the espn_s2 cookie from a logged-in browser
//   ESPN_SWID  – the SWID cookie (with or without curly braces)
// Optional variables:
//   LEAGUE_ID  – defaults to 58300197
//   SEASON     – defaults to 2026
//
// Responses are cached briefly so that many people refreshing at once only
// cause one round of requests to ESPN: LIVE_CACHE_SECONDS while an NFL game is
// in progress (the page refreshes every 5 seconds then), IDLE_CACHE_SECONDS
// otherwise.

import {
  fetchLeague,
  buildScoreboard,
  EspnError,
  ROSTER_VIEWS,
  fetchNflGames,
  gameStates,
  gameRemaining,
  hasRosters,
  buildActivePlayers,
} from "../../lib/espn.js";

const LIVE_CACHE_SECONDS = 4;
const IDLE_CACHE_SECONDS = 30;
const DEFAULT_LEAGUE_ID = "58300197";
const DEFAULT_SEASON = "2026";

// Per-isolate memory cache plus in-flight request sharing. Backed up by the
// Cloudflare Cache API, which is shared across isolates in a data center.
let memo = null; // { key, expires, body, ttl }
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
    const states = gameStates(nflRaw);
    data.gameActive = [...states.values()].includes("in");
    data.activePlayers = buildActivePlayers(
      rosterRaw,
      data.teams,
      states,
      rosterRaw.scoringPeriodId ?? scoringPeriodId,
      week,
      gameRemaining(nflRaw)
    );
  } catch {
    data.activePlayers = null;
    data.gameActive = null;
    data.playersError = "Live player data is unavailable right now. Try refreshing in a moment.";
  }
  data.fetchedAt = new Date().toISOString();
  return { body: JSON.stringify(data), ttl: data.gameActive ? LIVE_CACHE_SECONDS : IDLE_CACHE_SECONDS };
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
        memo = { key, expires: now + LIVE_CACHE_SECONDS * 1000, body };
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
    const { body, ttl } = await inflight.promise;
    memo = { key, expires: Date.now() + ttl * 1000, body };
    if (cache) {
      const put = cache
        .put(cacheKey, new Response(body, { headers: { "Cache-Control": `max-age=${ttl}` } }))
        .catch(() => {});
      if (waitUntil) waitUntil(put);
    }
    return json(body);
  } catch (err) {
    const e = err instanceof EspnError ? err : new EspnError("Something went wrong loading scores.");
    return json(JSON.stringify({ error: e.message, code: e.code, diagnostics: e.diagnostics }), e.status);
  }
}
