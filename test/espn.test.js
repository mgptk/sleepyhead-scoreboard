import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { addProjections, buildActivePlayers, gameStates, gameRemaining, fractionRemaining, liveProjection, hasRosters, buildScoreboard, fetchLeague, leagueUrl, EspnError, normalizeEspnS2, normalizeSwid } from "../lib/espn.js";

const sample = JSON.parse(readFileSync(new URL("./fixtures/sample-league.json", import.meta.url)));
const sampleNfl = JSON.parse(readFileSync(new URL("./fixtures/sample-nfl.json", import.meta.url)));

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

test("active players: starters whose NFL game is in progress", () => {
  const states = new Map([["1", "in"], ["2", "pre"], ["3", "post"]]);
  const player = (id, proTeamId, lineupSlotId, actual, proj) => ({
    playerId: id,
    lineupSlotId,
    playerPoolEntry: {
      appliedStatTotal: 999,
      player: {
        id,
        fullName: `P${id}`,
        proTeamId,
        stats: [
          { statSourceId: 0, statSplitTypeId: 1, scoringPeriodId: 5, appliedTotal: actual },
          { statSourceId: 1, statSplitTypeId: 1, scoringPeriodId: 5, appliedTotal: proj },
          { statSourceId: 1, statSplitTypeId: 1, scoringPeriodId: 4, appliedTotal: 50 },
        ],
      },
    },
  });
  const raw = {
    schedule: [
      {
        matchupPeriodId: 5,
        home: {
          teamId: 7,
          rosterForCurrentScoringPeriod: {
            entries: [
              player(1, 1, 2, 12.345, 14), // in game, starter → included
              player(2, 1, 20, 3, 4), // in game, bench → excluded
              player(3, 1, 21, 3, 4), // in game, IR → excluded
              player(4, 2, 2, 0, 9), // game not started → excluded
              player(5, 3, 4, 20, 10), // game over → excluded
            ],
          },
        },
      },
      { matchupPeriodId: 4, home: { teamId: 7, rosterForCurrentScoringPeriod: { entries: [player(9, 1, 2, 1, 1)] } } },
    ],
  };
  const teams = [{ id: 7, name: "Big Dogs", abbrev: "BIG" }];
  assert.equal(hasRosters(raw, 5), true);
  assert.equal(hasRosters(raw, 6), false);
  const players = buildActivePlayers(raw, teams, states, 5, 5);
  // Without game-clock data, Projected is the pregame projection.
  assert.deepEqual(players, [{ id: 1, name: "P1", teamId: 7, teamAbbrev: "BIG", points: 12.35, projected: 14, pregameProjected: 14 }]);
  // At halftime: 12.345 so far + 14 x 0.5 still to play.
  const live = buildActivePlayers(raw, teams, states, 5, 5, new Map([["1", 0.5]]));
  assert.equal(live[0].projected, 19.35);
  assert.equal(live[0].pregameProjected, 14);
});

test("game states come from the NFL scoreboard", () => {
  const states = gameStates(sampleNfl);
  assert.equal(states.size, 32);
  assert.equal(states.get("1"), "in");
  assert.equal(states.get("34"), "post");
  const sb = buildScoreboard(sample, []);
  const players = buildActivePlayers(sample, sb.teams, states, 13, 13);
  assert.ok(players.length > 0);
  assert.ok(players.every((p) => states.get(String(sample.schedule.flatMap((m) => [m.home, m.away]).filter(Boolean)
    .flatMap((s) => s.rosterForCurrentScoringPeriod ? s.rosterForCurrentScoringPeriod.entries : [])
    .find((e) => e.playerId === p.id).playerPoolEntry.player.proTeamId)) === "in"));
});

test("fraction of game remaining from quarter and clock", () => {
  assert.equal(fractionRemaining(0, 0), 1); // not started
  assert.equal(fractionRemaining(1, 900), 1); // kickoff
  assert.equal(fractionRemaining(2, 0), 0.5); // halftime
  assert.equal(fractionRemaining(3, 450), 0.375);
  assert.equal(fractionRemaining(4, 0), 0); // end of regulation
  assert.equal(fractionRemaining(5, 300), 0); // overtime
});

test("game remaining reads in-progress games only, with clock or displayClock", () => {
  const nfl = {
    events: [
      { competitions: [{ status: { type: { state: "in" }, period: 2, clock: 0 }, competitors: [{ team: { id: "1" } }, { team: { id: "2" } }] }] },
      { competitions: [{ status: { type: { state: "in" }, period: 4, displayClock: "7:30" }, competitors: [{ team: { id: "3" } }, { team: { id: "4" } }] }] },
      { competitions: [{ status: { type: { state: "post" }, period: 4, clock: 0 }, competitors: [{ team: { id: "5" } }] }] },
    ],
  };
  const r = gameRemaining(nfl);
  assert.equal(r.get("1"), 0.5);
  assert.equal(r.get("4"), 450 / 3600);
  assert.equal(r.has("5"), false);
});

test("live projection", () => {
  assert.equal(liveProjection(9, 16, 0.5), 17);
  assert.equal(liveProjection(20, 10, 0), 20); // game effectively over
  assert.equal(liveProjection(3, 12, null), 12); // no clock data → pregame
  assert.equal(liveProjection(3, null, 0.5), null);
});
