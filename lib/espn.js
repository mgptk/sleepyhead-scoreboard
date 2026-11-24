// Fetches league data from ESPN's fantasy football API and reduces it to the
// small shape the scoreboard needs. Shared by the Cloudflare Pages Function
// and the local dev server.

const ESPN_BASE = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons";
const VIEWS = ["mTeam", "mMatchupScore", "mScoreboard", "mSettings", "mStatus"];

export function leagueUrl(leagueId, season) {
  const params = VIEWS.map((v) => `view=${v}`).join("&");
  return `${ESPN_BASE}/${encodeURIComponent(season)}/segments/0/leagues/${encodeURIComponent(leagueId)}?${params}`;
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

export async function fetchLeague({ leagueId, season, espnS2, swid }, fetchImpl = fetch) {
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

  let res;
  try {
    res = await fetchImpl(leagueUrl(leagueId, season), { headers, redirect: "manual" });
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

export function buildScoreboard(raw) {
  const status = raw.status || {};
  const week = status.currentMatchupPeriod ?? raw.scoringPeriodId ?? null;
  const scores = weekScores(raw.schedule, week);

  const teams = (raw.teams || []).map((t) => {
    const overall = (t.record && t.record.overall) || {};
    const s = scores.get(t.id) || {};
    const standing = num(t.playoffSeed) || num(t.rankCalculatedFinal) || num(t.currentProjectedRank);
    return {
      id: t.id,
      name: teamName(t),
      abbrev: t.abbrev || "",
      logo: typeof t.logo === "string" && /^https?:\/\//.test(t.logo) ? t.logo : null,
      standing: standing || null,
      wins: num(overall.wins) ?? 0,
      losses: num(overall.losses) ?? 0,
      ties: num(overall.ties) ?? 0,
      pct: num(overall.percentage),
      points: round2(s.points ?? null),
      projected: round2(s.projected ?? null),
    };
  });

  return {
    leagueName: (raw.settings && raw.settings.name) || "Fantasy League",
    season: raw.seasonId ?? null,
    week,
    teams,
  };
}
