// Fetches league data from ESPN's fantasy football API and reduces it to the
// small shape the scoreboard needs. Shared by the Cloudflare Pages Function
// and the local dev server.

import { LEAGUE_RECORDS } from "./records.js";

const ESPN_BASE = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons";
const VIEWS = ["mTeam", "mMatchupScore", "mScoreboard", "mSettings", "mStatus"];

export function leagueUrl(leagueId, season, { views = VIEWS, scoringPeriodId } = {}) {
  const params = views.map((v) => `view=${v}`);
  if (scoringPeriodId != null) params.push(`scoringPeriodId=${encodeURIComponent(scoringPeriodId)}`);
  return `${ESPN_BASE}/${encodeURIComponent(season)}/segments/0/leagues/${encodeURIComponent(leagueId)}?${params.join("&")}`;
}

export class EspnError extends Error {
  constructor(message, { status = 502, code = "espn_error", diagnostics } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.diagnostics = diagnostics;
  }
}

// Cleans up common copy-paste mistakes: whitespace, surrounding quotes, and a
// leading "espn_s2=" / "SWID=" name.
function cleanSecret(value, name) {
  let s = String(value ?? "").trim();
  s = s.replace(new RegExp(`^${name}\\s*[=:]\\s*`, "i"), "");
  s = s.replace(/;$/, "").trim();
  s = s.replace(/^["']+|["']+$/g, "").trim();
  return s;
}

// espn_s2 must be URL-encoded exactly as the browser stores it (it contains
// %2B, %2F, %3D). Some dev tools show it decoded; re-encode in that case.
export function normalizeEspnS2(value) {
  const s = cleanSecret(value, "espn_s2");
  if (!s.includes("%") && /[+/=\s]/.test(s)) return encodeURIComponent(s.replace(/\s+/g, ""));
  return s.replace(/\s+/g, "");
}

// SWID must include its curly braces; accept it with or without them.
export function normalizeSwid(value) {
  const s = cleanSecret(value, "swid").replace(/\s+/g, "");
  if (!s) return "";
  return s.startsWith("{") ? s : `{${s.replace(/[{}]/g, "")}}`;
}

const GUID = /^\{[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\}$/i;

// Facts about the configured cookies that help explain a rejection without
// revealing their values.
function describeCookies(espnS2, swid) {
  return {
    espnS2Set: Boolean(espnS2),
    espnS2Length: espnS2.length,
    swidSet: Boolean(swid),
    swidLooksValid: GUID.test(swid),
  };
}

// views / scoringPeriodId / matchupPeriodId are optional; they are used to
// fetch starting lineups for one week.
export async function fetchLeague(
  { leagueId, season, espnS2, swid, views, scoringPeriodId, matchupPeriodId },
  fetchImpl = fetch
) {
  if (!leagueId || !season) {
    throw new EspnError("League ID or season is not configured.", { status: 500, code: "config" });
  }
  const s2 = normalizeEspnS2(espnS2);
  const sw = normalizeSwid(swid);
  const cookies = describeCookies(s2, sw);

  if (!s2 || !sw) {
    throw new EspnError(
      "The ESPN_S2 and/or ESPN_SWID secrets are not set on the server, or the site was not redeployed after adding them.",
      { status: 500, code: "missing_secrets", diagnostics: cookies }
    );
  }

  const headers = {
    Accept: "application/json",
    "User-Agent": "Mozilla/5.0 (compatible; league-scoreboard/1.0)",
    Cookie: `espn_s2=${s2}; SWID=${sw}`,
  };
  if (matchupPeriodId != null) {
    headers["X-Fantasy-Filter"] = JSON.stringify({ schedule: { filterMatchupPeriodIds: { value: [matchupPeriodId] } } });
  }

  let res;
  try {
    res = await fetchImpl(leagueUrl(leagueId, season, { views, scoringPeriodId }), { headers, redirect: "manual" });
  } catch {
    throw new EspnError("Could not reach ESPN. Try again in a moment.", { code: "network" });
  }
  const diagnostics = { ...cookies, espnStatus: res.status };

  if (res.status === 401 || (res.status >= 300 && res.status < 400)) {
    throw new EspnError(
      "ESPN rejected the login. The league owner needs to update the ESPN cookies.",
      { code: "auth", diagnostics }
    );
  }
  if (res.status === 403) {
    throw new EspnError(
      "ESPN refused the request (403). Either the cookies are wrong or ESPN is blocking the server.",
      { code: "forbidden", diagnostics }
    );
  }
  if (res.status === 404) {
    throw new EspnError("ESPN could not find this league or season.", { code: "not_found", diagnostics });
  }
  if (!res.ok) {
    throw new EspnError(`ESPN returned an error (${res.status}). Try again in a moment.`, { diagnostics });
  }

  try {
    return await res.json();
  } catch {
    // ESPN serves an HTML login page instead of JSON when cookies are bad.
    throw new EspnError(
      "ESPN rejected the login. The league owner needs to update the ESPN cookies.",
      { code: "auth", diagnostics: { ...diagnostics, nonJson: true } }
    );
  }
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const round2 = (v) => (v == null ? null : Math.round(v * 100) / 100);

function teamName(t) {
  if (t.name && String(t.name).trim()) return String(t.name).trim();
  const joined = [t.location, t.nickname].filter(Boolean).join(" ").trim();
  return joined || t.abbrev || `Team ${t.id}`;
}

// A team's live score and projection for the current matchup period, read from
// its own side of the schedule entry. Opponents are never included.
function weekScores(schedule, matchupPeriodId) {
  const byTeam = new Map();
  for (const m of schedule || []) {
    if (m.matchupPeriodId !== matchupPeriodId) continue;
    for (const side of [m.home, m.away]) {
      if (!side || side.teamId == null) continue;
      byTeam.set(side.teamId, {
        points: num(side.totalPointsLive) ?? num(side.totalPoints),
        projected: num(side.totalProjectedPointsLive) ?? num(side.totalProjectedPoints),
      });
    }
  }
  return byTeam;
}

// Projected result of the current week under median scoring: teams ranked by
// projected points; the top half win, the bottom half lose, and with an odd
// number of teams the median team ties. Adds the projected record and the
// projected standing (by win %, ties broken by current standing).
export function addProjections(teams) {
  const blank = { projOutcome: null, projWins: null, projLosses: null, projTies: null, projPct: null, projStanding: null };
  const byStanding = (a, b) => (a.standing ?? 99) - (b.standing ?? 99);
  if (!teams.length || teams.some((t) => t.projected == null)) {
    teams.forEach((t) => Object.assign(t, blank));
    return teams;
  }

  const n = teams.length;
  const ranked = [...teams].sort((a, b) => b.projected - a.projected || byStanding(a, b));
  ranked.forEach((t, i) => {
    const outcome = n % 2 === 1 && i === (n - 1) / 2 ? "T" : i < n / 2 ? "W" : "L";
    const wins = t.wins + (outcome === "W" ? 1 : 0);
    const losses = t.losses + (outcome === "L" ? 1 : 0);
    const ties = t.ties + (outcome === "T" ? 1 : 0);
    const games = wins + losses + ties;
    Object.assign(t, { projOutcome: outcome, projWins: wins, projLosses: losses, projTies: ties, projPct: (wins + ties / 2) / games });
  });

  [...teams]
    .sort((a, b) => b.projPct - a.projPct || byStanding(a, b))
    .forEach((t, i) => { t.projStanding = i + 1; });
  return teams;
}

const nameKey = (name) =>
  String(name).normalize("NFKC").replace(/[\u2018\u2019\u02BC`]/g, "'").replace(/\s+/g, " ").trim().toLowerCase();

// Map of team name → { wins, losses, ties, pct, standing } from LEAGUE_RECORDS.
function recordOverrides(list) {
  const map = new Map();
  list.forEach(([name, record], i) => {
    const [wins = 0, losses = 0, ties = 0] = String(record).split("-").map(Number);
    const games = wins + losses + ties;
    map.set(nameKey(name), { wins, losses, ties, pct: games ? (wins + ties / 2) / games : null, standing: i + 1 });
  });
  return map;
}

export function buildScoreboard(raw, records = LEAGUE_RECORDS) {
  const overrides = recordOverrides(records);
  const status = raw.status || {};
  const week = status.currentMatchupPeriod ?? raw.scoringPeriodId ?? null;
  const scores = weekScores(raw.schedule, week);

  const teams = (raw.teams || []).map((t) => {
    const overall = (t.record && t.record.overall) || {};
    const s = scores.get(t.id) || {};
    const standing = num(t.playoffSeed) || num(t.rankCalculatedFinal) || num(t.currentProjectedRank);
    const custom = overrides.get(nameKey(teamName(t)));
    return {
      id: t.id,
      name: teamName(t),
      abbrev: t.abbrev || "",
      logo: typeof t.logo === "string" && /^https?:\/\//.test(t.logo) ? t.logo : null,
      standing: custom ? custom.standing : standing || null,
      wins: custom ? custom.wins : num(overall.wins) ?? 0,
      losses: custom ? custom.losses : num(overall.losses) ?? 0,
      ties: custom ? custom.ties : num(overall.ties) ?? 0,
      pct: custom ? custom.pct : num(overall.percentage),
      points: round2(s.points ?? null),
      projected: round2(s.projected ?? null),
    };
  });

  addProjections(teams);

  return {
    leagueName: (raw.settings && raw.settings.name) || "Fantasy League",
    season: raw.seasonId ?? null,
    week,
    teams,
  };
}

// ---- Active players -------------------------------------------------------

// ESPN's public NFL scoreboard (no login). Used to tell which NFL games are in
// progress, since fantasy roster data has no "game in progress" flag.
const NFL_SCOREBOARD = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard";
export const ROSTER_VIEWS = ["mMatchupScore", "mScoreboard"];
const NON_STARTER_SLOTS = new Set([20, 21]); // 20 = bench, 21 = IR

export async function fetchNflGames(fetchImpl = fetch) {
  const res = await fetchImpl(NFL_SCOREBOARD, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`NFL scoreboard returned ${res.status}`);
  return res.json();
}

// Map of NFL team id (same ids as fantasy proTeamId) → "pre" | "in" | "post".
export function gameStates(nflRaw) {
  const states = new Map();
  for (const ev of (nflRaw && nflRaw.events) || []) {
    const comp = (ev.competitions || [])[0] || {};
    const state = (comp.status && comp.status.type && comp.status.type.state) || (ev.status && ev.status.type && ev.status.type.state);
    for (const c of comp.competitors || []) {
      if (c.team && c.team.id != null) states.set(String(c.team.id), state);
    }
  }
  return states;
}

// Seconds left in a quarter from ESPN's status: `clock` (seconds) or
// `displayClock` ("7:32").
function clockSeconds(status) {
  if (typeof status.clock === "number" && Number.isFinite(status.clock)) return status.clock;
  const m = /^(\d+):(\d{2})/.exec(String(status.displayClock || ""));
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
}

// Fraction of regulation (4 x 15 minutes) left in a game, from 1 at kickoff to
// 0 at the end of the 4th quarter. Overtime counts as 0.
export function fractionRemaining(period, clock) {
  if (!period || period < 1) return 1;
  if (period > 4) return 0;
  return Math.max(0, Math.min(1, ((4 - period) * 900 + clock) / 3600));
}

// Map of NFL team id → fraction of its game remaining, for games in progress.
export function gameRemaining(nflRaw) {
  const remaining = new Map();
  for (const ev of (nflRaw && nflRaw.events) || []) {
    const comp = (ev.competitions || [])[0] || {};
    const status = comp.status || ev.status || {};
    const state = status.type && status.type.state;
    if (state !== "in") continue;
    const frac = fractionRemaining(Number(status.period), clockSeconds(status));
    for (const c of comp.competitors || []) {
      if (c.team && c.team.id != null) remaining.set(String(c.team.id), frac);
    }
  }
  return remaining;
}

// Live projection: points so far plus the pregame projection scaled by the
// share of the game still to play (ESPN's approach for in-game projections).
export function liveProjection(points, pregame, remaining) {
  if (pregame == null) return null;
  if (remaining == null) return pregame;
  return (points ?? 0) + pregame * remaining;
}

// True when the league data already includes starting lineups for the week.
export function hasRosters(raw, matchupPeriodId) {
  return (raw.schedule || []).some(
    (m) =>
      m.matchupPeriodId === matchupPeriodId &&
      [m.home, m.away].some((s) => s && s.rosterForCurrentScoringPeriod && (s.rosterForCurrentScoringPeriod.entries || []).length)
  );
}

function shortName(team) {
  if (team.abbrev) return team.abbrev;
  return team.name.split(/\s+/).map((w) => w[0]).join("").slice(0, 4).toUpperCase();
}

// Starters whose NFL game is in progress, with this week's score and ESPN
// projection, and the abbreviation of the fantasy team they play for.
// remaining: optional map from gameRemaining(); when given, Projected is the
// live projection instead of the pregame one.
export function buildActivePlayers(rosterRaw, teams, states, scoringPeriodId, matchupPeriodId, remaining = new Map()) {
  const abbrevs = new Map(teams.map((t) => [t.id, shortName(t)]));
  const players = [];
  for (const m of rosterRaw.schedule || []) {
    if (m.matchupPeriodId !== matchupPeriodId) continue;
    for (const side of [m.home, m.away]) {
      if (!side || !side.rosterForCurrentScoringPeriod) continue;
      for (const entry of side.rosterForCurrentScoringPeriod.entries || []) {
        if (NON_STARTER_SLOTS.has(entry.lineupSlotId)) continue;
        const pool = entry.playerPoolEntry || {};
        const p = pool.player || {};
        if (states.get(String(p.proTeamId)) !== "in") continue;
        const stats = p.stats || [];
        const stat = (source) =>
          stats.find(
            (st) => st.statSourceId === source && st.scoringPeriodId === scoringPeriodId && (st.statSplitTypeId == null || st.statSplitTypeId === 1)
          );
        const actual = stat(0);
        const proj = stat(1);
        const points = num(actual && actual.appliedTotal) ?? num(pool.appliedStatTotal) ?? 0;
        const pregame = num(proj && proj.appliedTotal);
        players.push({
          id: p.id ?? entry.playerId ?? null,
          name: p.fullName || "Unknown player",
          teamId: side.teamId,
          teamAbbrev: abbrevs.get(side.teamId) || "",
          points: round2(points),
          projected: round2(liveProjection(points, pregame, remaining.get(String(p.proTeamId)))),
          pregameProjected: round2(pregame),
        });
      }
    }
  }
  return players;
}
