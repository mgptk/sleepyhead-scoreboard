// Cloudflare Pages Function: GET /api/scoreboard
//
// Required secrets (Worker or Pages project → Settings → Variables and Secrets,
// NOT Settings → Build → Variables and secrets, which only exist during builds):
//   ESPN_S2    – the espn_s2 cookie from a logged-in browser
//   ESPN_SWID  – the SWID cookie (with or without curly braces)
// Optional variables:
//   LEAGUE_ID  – defaults to 58300197
//   SEASON     – defaults to 2026
//
// Responses are cached for CACHE_SECONDS so that many people pressing Refresh
// at once only cause one request to ESPN.

import { fetchLeague, buildScoreboard, EspnError } from "../../lib/espn.js";

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

// Look up a setting by name, ignoring case and stray spaces in the name, so
// "espn_s2" or "ESPN_S2 " still work.
function setting(env, ...names) {
  const wanted = names.map((n) => n.toLowerCase());
  for (const [k, v] of Object.entries(env || {})) {
    if (typeof v === "string" && wanted.includes(k.trim().toLowerCase())) return v;
  }
  return undefined;
}

// Names (never values) of settings that look ESPN-related, to spot typos.
function relatedNames(env) {
  return Object.keys(env || {}).filter((k) => /espn|swid|s2|league|season/i.test(k));
}

async function load(env) {
  const raw = await fetchLeague({
    leagueId: setting(env, "LEAGUE_ID") || DEFAULT_LEAGUE_ID,
    season: setting(env, "SEASON") || DEFAULT_SEASON,
    espnS2: setting(env, "ESPN_S2", "ESPNS2", "S2"),
    swid: setting(env, "ESPN_SWID", "SWID"),
  });
  const data = buildScoreboard(raw);
  data.fetchedAt = new Date().toISOString();
  return JSON.stringify(data);
}

export async function onRequestGet({ request, env, waitUntil }) {
  const leagueId = setting(env, "LEAGUE_ID") || DEFAULT_LEAGUE_ID;
  const season = setting(env, "SEASON") || DEFAULT_SEASON;
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
    const diagnostics = e.diagnostics && { ...e.diagnostics, settingNamesFound: relatedNames(env) };
    return json(JSON.stringify({ error: e.message, code: e.code, diagnostics }), e.status);
  }
}
