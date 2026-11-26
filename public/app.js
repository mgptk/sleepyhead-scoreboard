const API_URL = "/api/scoreboard";

// Automatic refresh: every 5 seconds while an NFL game is in progress,
// otherwise once a minute (which is also how a game starting is noticed).
const LIVE_REFRESH_MS = 5000;
const IDLE_REFRESH_MS = 60000;

// Default sort direction for each sortable column.
const DEFAULT_DIR = { standing: "asc", record: "desc", points: "desc", projected: "desc" };

const state = {
  data: null,
  sortKey: "points",
  sortDir: "desc",
  mode: "current", // "current" or "projected": which Standing and W-L to show
  view: "teams", // "teams" (scoreboard) or "players" (active players)
  pSortKey: "points",
  pSortDir: "desc",
  loading: false,
  timer: null,
};

const $ = (id) => document.getElementById(id);
const rowsEl = $("rows");
const bannerEl = $("banner");
const refreshBtn = $("refresh");
const boardEl = $("board");
const playersBtn = $("players-toggle");

// Standing and record for the selected mode. In projected mode these include
// this week's projected median result.
function view(t) {
  if (state.mode === "projected") {
    if (t.projStanding == null) return { standing: null, wins: null, losses: null, ties: null, pct: null };
    return { standing: t.projStanding, wins: t.projWins, losses: t.projLosses, ties: t.projTies, pct: t.projPct };
  }
  return { standing: t.standing, wins: t.wins, losses: t.losses, ties: t.ties, pct: t.pct };
}

function recordValue(v) {
  if (v.wins == null) return null;
  const games = v.wins + v.losses + v.ties;
  if (v.pct != null) return v.pct;
  return games ? (v.wins + v.ties / 2) / games : 0;
}

function sortValue(t, key) {
  if (key === "record") return recordValue(view(t));
  if (key === "standing") return view(t).standing;
  return t[key];
}

function sortedTeams(teams, key, dir) {
  const sign = dir === "asc" ? 1 : -1;
  return [...teams].sort((a, b) => {
    const va = sortValue(a, key);
    const vb = sortValue(b, key);
    // Missing values always go last, whatever the direction.
    if (va == null && vb != null) return 1;
    if (vb == null && va != null) return -1;
    if (va != null && vb != null && va !== vb) return (va - vb) * sign;
    // Tie-break by standings so the order is stable and sensible.
    return (view(a).standing ?? 99) - (view(b).standing ?? 99);
  });
}

function fmtPoints(v) {
  return v == null ? "—" : v.toFixed(2);
}

function fmtRecord(v) {
  if (v.wins == null) return "—";
  return v.ties ? `${v.wins}-${v.losses}-${v.ties}` : `${v.wins}-${v.losses}`;
}

function initials(t) {
  if (t.abbrev) return t.abbrev.slice(0, 4).toUpperCase();
  return t.name.split(/\s+/).map((w) => w[0]).join("").slice(0, 3).toUpperCase();
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function logoNode(t) {
  const fallback = () => el("span", "logo fallback", initials(t));
  if (!t.logo) return fallback();
  const img = el("img", "logo");
  img.alt = "";
  img.loading = "lazy";
  img.decoding = "async";
  img.referrerPolicy = "no-referrer";
  img.src = t.logo;
  img.addEventListener("error", () => img.replaceWith(fallback()), { once: true });
  return img;
}

function renderRows() {
  if (!state.data) return;
  const teams = sortedTeams(state.data.teams, state.sortKey, state.sortDir);
  const frag = document.createDocumentFragment();
  teams.forEach((t, i) => {
    const row = el("div", "row");
    row.setAttribute("role", "row");
    row.append(el("span", "c-idx", String(i + 1)));
    const team = el("span", "c-team");
    team.append(logoNode(t), el("span", "name", t.name));
    team.title = t.name;
    row.append(team);
    const v = view(t);
    row.append(el("span", "c-std", v.standing == null ? "—" : String(v.standing)));
    row.append(el("span", "c-rec", fmtRecord(v)));
    row.append(el("span", "c-pts", fmtPoints(t.points)));
    row.append(el("span", "c-proj", fmtPoints(t.projected)));
    frag.append(row);
  });
  rowsEl.replaceChildren(frag);
}

function sortedPlayers(players, key, dir) {
  const sign = dir === "asc" ? 1 : -1;
  return [...players].sort((a, b) => {
    const va = a[key];
    const vb = b[key];
    if (va == null && vb != null) return 1;
    if (vb == null && va != null) return -1;
    if (va != null && vb != null && va !== vb) return (va - vb) * sign;
    return a.name.localeCompare(b.name);
  });
}

function renderPlayers() {
  const d = state.data;
  if (!d) return;
  if (d.activePlayers == null) {
    rowsEl.replaceChildren(el("div", "empty", d.playersError || "Live player data is unavailable right now."));
    return;
  }
  if (!d.activePlayers.length) {
    rowsEl.replaceChildren(el("div", "empty", "No starters are in a game right now."));
    return;
  }
  const frag = document.createDocumentFragment();
  for (const p of sortedPlayers(d.activePlayers, state.pSortKey, state.pSortDir)) {
    const row = el("div", "row");
    row.setAttribute("role", "row");
    const player = el("span", "c-player");
    player.append(el("span", "name", p.name));
    player.title = p.name;
    row.append(player);
    row.append(el("span", "c-fteam", p.teamAbbrev));
    row.append(el("span", "c-pts", fmtPoints(p.points)));
    row.append(el("span", "c-proj", fmtPoints(p.projected)));
    frag.append(row);
  }
  rowsEl.replaceChildren(frag);
}

function render() {
  if (state.view === "players") renderPlayers();
  else renderRows();
}

function setView(view) {
  state.view = view;
  const players = view === "players";
  boardEl.classList.toggle("players", players);
  document.querySelector(".teams-head").hidden = players;
  document.querySelector(".players-head").hidden = !players;
  playersBtn.setAttribute("aria-pressed", String(players));
  document.querySelector(".segmented").classList.toggle("dimmed", players);
  rowsEl.scrollTop = 0;
  render();
}

function renderSkeleton() {
  const frag = document.createDocumentFragment();
  for (let i = 0; i < 11; i++) {
    const row = el("div", "row skeleton");
    row.append(el("span", "c-idx", String(i + 1)));
    const team = el("span", "c-team");
    const bar = el("span", "bar");
    bar.style.width = `${50 + ((i * 37) % 40)}%`;
    team.append(el("span", "logo"), bar);
    row.append(team);
    for (const c of ["c-std", "c-rec", "c-pts", "c-proj"]) {
      const cell = el("span", c);
      cell.append(el("span", "bar"));
      row.append(cell);
    }
    frag.append(row);
  }
  rowsEl.replaceChildren(frag);
}

function renderSortHeaders() {
  document.querySelectorAll(".sort").forEach((btn) => {
    const isPlayer = btn.dataset.pkey != null;
    const active = isPlayer ? btn.dataset.pkey === state.pSortKey : btn.dataset.key === state.sortKey;
    const dir = isPlayer ? state.pSortDir : state.sortDir;
    if (active) btn.setAttribute("aria-sort", dir === "asc" ? "ascending" : "descending");
    else btn.removeAttribute("aria-sort");
  });
}

function renderHeader() {
  const d = state.data;
  if (!d) return;
  $("league-name").textContent = d.leagueName;
  document.title = d.leagueName;
  const parts = [];
  if (d.week != null) parts.push(`Week ${d.week}`);
  if (d.fetchedAt) {
    const t = new Date(d.fetchedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    parts.push(`Updated ${t}`);
  }
  if (d.gameActive) parts.push("Live");
  if (d.sample) parts.push("Sample data");
  $("subtitle").textContent = parts.join(" · ");
}

function showBanner(message, kind = "error") {
  if (!message) {
    bannerEl.hidden = true;
    bannerEl.textContent = "";
    return;
  }
  bannerEl.className = kind === "info" ? "banner info" : "banner";
  bannerEl.textContent = message;
  bannerEl.hidden = false;
}

function setLoading(on) {
  state.loading = on;
  refreshBtn.disabled = on;
  refreshBtn.classList.toggle("loading", on);
}

function scheduleRefresh() {
  clearTimeout(state.timer);
  state.timer = null;
  if (document.hidden) return; // paused while the page isn't visible
  const delay = state.data && state.data.gameActive ? LIVE_REFRESH_MS : IDLE_REFRESH_MS;
  state.timer = setTimeout(() => load({ quiet: true }), delay);
}

// quiet: automatic refresh, without the spinning Refresh button.
async function load({ quiet = false } = {}) {
  if (state.loading) return;
  clearTimeout(state.timer);
  state.loading = true;
  if (!quiet) setLoading(true);
  if (!state.data) renderSkeleton();
  try {
    const res = await fetch(API_URL, { cache: "no-store" });
    let body = null;
    try { body = await res.json(); } catch { /* non-JSON */ }
    if (!res.ok || !body || body.error) {
      throw new Error((body && body.error) || `Could not load scores (${res.status}).`);
    }
    state.data = body;
    showBanner(null);
    renderHeader();
    render();
  } catch (err) {
    const msg = err instanceof TypeError ? "Network error. Check your connection and try again." : err.message;
    showBanner(state.data ? `${msg} Showing the last scores loaded.` : msg);
    if (!state.data) {
      rowsEl.replaceChildren();
      $("subtitle").textContent = "Scores unavailable";
    }
  } finally {
    state.loading = false;
    setLoading(false);
    scheduleRefresh();
  }
}

document.querySelectorAll(".sort[data-key]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const key = btn.dataset.key;
    if (key === state.sortKey) state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
    else {
      state.sortKey = key;
      state.sortDir = DEFAULT_DIR[key];
    }
    renderSortHeaders();
    renderRows();
  });
});

document.querySelectorAll(".sort[data-pkey]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const key = btn.dataset.pkey;
    if (key === state.pSortKey) state.pSortDir = state.pSortDir === "asc" ? "desc" : "asc";
    else {
      state.pSortKey = key;
      state.pSortDir = "desc";
    }
    renderSortHeaders();
    renderPlayers();
  });
});

// Current / Projected. Tapping either while on Active Players returns to the
// scoreboard in that mode.
document.querySelectorAll(".segmented button").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (state.mode === btn.dataset.mode && state.view === "teams") return;
    state.mode = btn.dataset.mode;
    document.querySelectorAll(".segmented button").forEach((b) => {
      b.setAttribute("aria-pressed", String(b.dataset.mode === state.mode));
    });
    if (state.view !== "teams") setView("teams");
    else renderRows();
  });
});

playersBtn.addEventListener("click", () => setView(state.view === "players" ? "teams" : "players"));

refreshBtn.addEventListener("click", () => load());

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    clearTimeout(state.timer);
    state.timer = null;
  } else {
    load({ quiet: true });
  }
});

renderSortHeaders();
load();
