const API_URL = "/api/scoreboard";

// Default sort direction for each sortable column.
const DEFAULT_DIR = { standing: "asc", record: "desc", points: "desc", projected: "desc" };

const state = {
  data: null,
  sortKey: "points",
  sortDir: "desc",
  mode: "current", // "current" or "projected": which Standing and W-L to show
  loading: false,
};

const $ = (id) => document.getElementById(id);
const rowsEl = $("rows");
const bannerEl = $("banner");
const refreshBtn = $("refresh");

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
    const active = btn.dataset.key === state.sortKey;
    if (active) btn.setAttribute("aria-sort", state.sortDir === "asc" ? "ascending" : "descending");
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

async function load() {
  if (state.loading) return;
  setLoading(true);
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
    renderRows();
  } catch (err) {
    const msg = err instanceof TypeError ? "Network error. Check your connection and try again." : err.message;
    showBanner(state.data ? `${msg} Showing the last scores loaded.` : msg);
    if (!state.data) {
      rowsEl.replaceChildren();
      $("subtitle").textContent = "Scores unavailable";
    }
  } finally {
    setLoading(false);
  }
}

document.querySelectorAll(".sort").forEach((btn) => {
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

document.querySelectorAll(".segmented button").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (state.mode === btn.dataset.mode) return;
    state.mode = btn.dataset.mode;
    document.querySelectorAll(".segmented button").forEach((b) => {
      b.setAttribute("aria-pressed", String(b.dataset.mode === state.mode));
    });
    renderRows();
  });
});

refreshBtn.addEventListener("click", load);

renderSortHeaders();
load();
