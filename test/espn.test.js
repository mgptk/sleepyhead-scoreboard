import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildScoreboard, fetchLeague, leagueUrl, EspnError } from "../lib/espn.js";

const sample = JSON.parse(readFileSync(new URL("./fixtures/sample-league.json", import.meta.url)));

test("builds one row per team with standing, record and week scores", () => {
  const sb = buildScoreboard(sample);
  assert.equal(sb.leagueName, "Sample League");
  assert.equal(sb.week, 13);
  assert.equal(sb.teams.length, 11);
  const t3 = sb.teams.find((t) => t.id === 3);
  assert.equal(t3.name, "Blitz Brigade");
  assert.equal(t3.standing, 1);
  assert.equal(t3.points, 102.36);
  assert.equal(t3.projected, 124.9);
});

test("ignores other matchup periods and handles a team without an opponent", () => {
  const sb = buildScoreboard(sample);
  const t1 = sb.teams.find((t) => t.id === 1);
  assert.equal(t1.points, 87.42); // not the period-12 value
  const t11 = sb.teams.find((t) => t.id === 11);
  assert.equal(t11.points, 0);
  assert.equal(t11.projected, 96.4);
});

test("falls back to location + nickname and to totalPoints", () => {
  const sb = buildScoreboard({
    status: { currentMatchupPeriod: 2 },
    teams: [{ id: 7, location: "Big", nickname: "Dogs", record: { overall: { wins: 1, losses: 0 } } }],
    schedule: [{ matchupPeriodId: 2, home: { teamId: 7, totalPoints: 55.5 } }],
  });
  assert.equal(sb.teams[0].name, "Big Dogs");
  assert.equal(sb.teams[0].points, 55.5);
  assert.equal(sb.teams[0].projected, null);
});

test("sends cookies and maps ESPN errors", async () => {
  let seen;
  const ok = async (url, opts) => { seen = { url, opts }; return new Response("{}", { status: 200 }); };
  await fetchLeague({ leagueId: "1", season: "2026", espnS2: "abc", swid: "XYZ" }, ok);
  assert.equal(seen.url, leagueUrl("1", "2026"));
  assert.equal(seen.opts.headers.Cookie, "espn_s2=abc; SWID={XYZ}");

  const unauthorized = async () => new Response("", { status: 401 });
  await assert.rejects(fetchLeague({ leagueId: "1", season: "2026" }, unauthorized), (e) => e instanceof EspnError && e.code === "auth");

  const html = async () => new Response("<html>login</html>", { status: 200 });
  await assert.rejects(fetchLeague({ leagueId: "1", season: "2026" }, html), (e) => e.code === "auth");
});
