// Local preview server: node scripts/dev.mjs
//   With ESPN_S2 and ESPN_SWID set, it loads the real league from ESPN.
//   Otherwise (or with SAMPLE=1) it serves made-up sample data, labeled as such.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { onRequestGet } from "../functions/api/scoreboard.js";
import { buildScoreboard, buildActivePlayers, gameStates } from "../lib/espn.js";

const root = fileURLToPath(new URL("../public/", import.meta.url));
const port = Number(process.env.PORT) || 8788;
const useSample = process.env.SAMPLE === "1" || !(process.env.ESPN_S2 && process.env.ESPN_SWID);
const types = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml" };

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  if (url.pathname === "/api/scoreboard") {
    if (useSample) {
      const raw = JSON.parse(await readFile(new URL("../test/fixtures/sample-league.json", import.meta.url)));
      const nfl = JSON.parse(await readFile(new URL("../test/fixtures/sample-nfl.json", import.meta.url)));
      const data = { ...buildScoreboard(raw), fetchedAt: new Date().toISOString(), sample: true };
      const states = gameStates(nfl);
      data.gameActive = process.env.SAMPLE_IDLE === "1" ? false : [...states.values()].includes("in");
      data.activePlayers = buildActivePlayers(raw, data.teams, states, raw.scoringPeriodId, data.week);
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(data));
    }
    const r = await onRequestGet({ request: new Request(url), env: process.env });
    res.writeHead(r.status, Object.fromEntries(r.headers));
    return res.end(await r.text());
  }
  const path = normalize(join(root, url.pathname === "/" ? "index.html" : url.pathname));
  if (!path.startsWith(root)) { res.writeHead(403); return res.end(); }
  try {
    const body = await readFile(path);
    res.writeHead(200, { "Content-Type": types[extname(path)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404); res.end("Not found");
  }
}).listen(port, () => console.log(`Scoreboard on http://localhost:${port} (${useSample ? "sample data" : "live ESPN data"})`));
