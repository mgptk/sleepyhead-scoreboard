import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { addProjections, buildScoreboard, fetchLeague, leagueUrl, EspnError, normalizeEspnS2, normalizeSwid } from "../lib/espn.js";

const sample = JSON.parse(readFileSync(new URL("./fixtures/sample-league.json", import.meta.url)));

test("league records replace ESPN records and set standings by list order", () => {
  const raw = {
    status: { currentMatchupPeriod: 1 },
    teams: [
      { id: 1, name: "Cook\u2019n  Lamb", playoffSeed: 5, record: { overall: { wins: 3, losses: 8 } } },
      { id: 2, name: "Not Listed", playoffSeed: 7, record: { overall: { wins: 4, losses: 7 } } },
      { id: 3, name: "emeka edge-buka", playoffSeed: 1, record: { overall: { wins: 10, losses: 1 } } },
    ],
  };
  const sb = buildScoreboard(raw);
  const [a, b, c] = sb.teams;
  assert.deepEqual([a.wins, a.losses, a.ties, a.standing], [9, 2, 0, 1]);
  assert.deepEqual([b.wins, b.losses, b.standing], [4, 7, 7]); // unlisted keeps ESPN values
  assert.deepEqual([c.wins, c.losses, c.ties, c.standing], [5, 5, 1, 6]);
  assert.equal(c.pct, 5.5 / 11);
  assert.equal(a.name, "Cook\u2019n  Lamb"); // name itself is unchanged
});

test("builds one row per team with standing, record and week scores", () => {
  const sb = buildScoreboard(sample, []);
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

  const creds = { leagueId: "1", season: "2026", espnS2: "abc", swid: "XYZ" };
  const unauthorized = async () => new Response("", { status: 401 });
  await assert.rejects(fetchLeague(creds, unauthorized), (e) => e instanceof EspnError && e.code === "auth" && e.diagnostics.espnStatus === 401);

  const forbidden = async () => new Response("", { status: 403 });
  await assert.rejects(fetchLeague(creds, forbidden), (e) => e.code === "forbidden");

  const html = async () => new Response("<html>login</html>", { status: 200 });
  await assert.rejects(fetchLeague(creds, html), (e) => e.code === "auth");

  let called = false;
  const never = async () => { called = true; return new Response("{}"); };
  await assert.rejects(fetchLeague({ leagueId: "1", season: "2026" }, never), (e) => e.code === "missing_secrets");
  assert.equal(called, false);
});

test("cleans up pasted cookie values", () => {
  assert.equal(normalizeEspnS2(' "AEB%2Bx%3D" \n'), "AEB%2Bx%3D");
  assert.equal(normalizeEspnS2("espn_s2=AEB%2Bx%3D;"), "AEB%2Bx%3D");
  assert.equal(normalizeEspnS2("AEB+x/y="), "AEB%2Bx%2Fy%3D"); // decoded copy gets re-encoded
  assert.equal(normalizeSwid("SWID={ABC}"), "{ABC}");
  assert.equal(normalizeSwid(" 'ABC' "), "{ABC}");
});

test("projects this week's median result, record and standing", () => {
  const sb = buildScoreboard(sample, []);
  const byId = Object.fromEntries(sb.teams.map((t) => [t.id, t]));
  const outcomes = sb.teams.map((t) => t.projOutcome);
  assert.equal(outcomes.filter((o) => o === "W").length, 5);
  assert.equal(outcomes.filter((o) => o === "L").length, 5);
  assert.equal(outcomes.filter((o) => o === "T").length, 1);
  assert.equal(byId[8].projOutcome, "W"); // highest projection (130.2)
  assert.equal(byId[5].projOutcome, "T"); // median projection (112.4)
  assert.equal(byId[9].projOutcome, "L"); // lowest projection (92.8)
  assert.deepEqual([byId[5].projWins, byId[5].projLosses, byId[5].projTies], [5, 7, 1]);
  assert.deepEqual([byId[3].projWins, byId[3].projLosses, byId[3].projStanding], [10, 3, 1]);
  assert.deepEqual(sb.teams.map((t) => t.projStanding).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
});

test("projected standing ties are broken by current standing", () => {
  const t = (id, standing, projected) => ({ id, standing, projected, wins: 5, losses: 5, ties: 0 });
  const teams = addProjections([t(1, 2, 100), t(2, 1, 90), t(3, 3, 80)]);
  // 1 wins, 2 ties (median), 3 loses
  assert.deepEqual(teams.map((x) => x.projOutcome), ["W", "T", "L"]);
  assert.deepEqual(teams.map((x) => x.projStanding), [1, 2, 3]);
  const even = addProjections([t(1, 1, 50), t(2, 2, 60)]);
  assert.deepEqual(even.map((x) => x.projOutcome), ["L", "W"]);
  assert.deepEqual(even.map((x) => x.projStanding), [2, 1]);
});

test("no projections means no projected values", () => {
  const teams = addProjections([{ id: 1, standing: 1, projected: null, wins: 1, losses: 0, ties: 0 }]);
  assert.equal(teams[0].projStanding, null);
  assert.equal(teams[0].projOutcome, null);
});
