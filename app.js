/* =====================================================
   SECTION 1: API LAYER
   ===================================================== */
const API_BASE = "https://cloud-computing-activity.vercel.app";
const API_KEY = "arceo-api-key-123";
// v2: the database API stores image paths as "league/<file>", so old cached rosters are skipped
const CACHE_KEY = "moba-hub:roster:v2";

// Fetch the whole roster once, then reuse it for the rest of the session.
async function getRoster() {
  const cached = sessionStorage.getItem(CACHE_KEY);
  if (cached) return JSON.parse(cached);

  const res = await fetch(`${API_BASE}/api/v1/characters`, {
    headers: { "x-api-key": API_KEY },
  });
  if (!res.ok) throw new Error(`API returned ${res.status}`);

  const data = await res.json(); // { count, characters: [...] }
  sessionStorage.setItem(CACHE_KEY, JSON.stringify(data.characters));
  return data.characters;
}

// For now the images sit in an "images" folder next to index.html.
// To serve them from the API instead, set IMAGE_BASE to `${API_BASE}/images/`.
const IMAGE_BASE = "images/";
function imageUrl(champion) {
  const file = champion.image || (champion.image_url ? champion.image_url.split("/").pop() : null);
  return file ? `${IMAGE_BASE}${file}` : null;
}

/* =====================================================
   SECTION 1B: ACCOUNTS AND EXP
   Sign-up, login, progress and account deletion all use the API.
   The login token is kept in localStorage until it expires.
   ===================================================== */
const SESSION_KEY = "moba-hub:session";
const EXP_PER_LEVEL = 100; // must match EXP_PER_LEVEL in the API's rules.py

let progressBySlug = {};   // game mode slug -> total EXP, filled after login

function getSession() {
  try {
    const session = JSON.parse(localStorage.getItem(SESSION_KEY));
    if (session && session.token && session.expiresAt > Date.now()) return session;
  } catch { /* storage blocked or corrupted: treat as logged out */ }
  return null;
}

function saveSession(session) {
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(session)); } catch { /* ignore */ }
}

function clearSession() {
  try { localStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
  progressBySlug = {};
  renderAccountBar();
  renderCategories();
}

function levelFor(exp) {
  return 1 + Math.floor(exp / EXP_PER_LEVEL);
}

// Turns any API error body into one readable sentence.
function errorMessage(data, fallback) {
  const detail = data && data.detail;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail) && detail.length) {
    return detail.map((d) => {
      const field = Array.isArray(d.loc) ? d.loc[d.loc.length - 1] : "";
      return field && field !== "body" ? `${field}: ${d.msg}` : d.msg;
    }).join(" ");
  }
  return fallback;
}

// Calls the API and returns { ok, status, data }. Never throws.
// With auth: true it sends the login token, and logs the player out if the token is rejected.
async function api(path, { method = "GET", body, auth = false } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (auth) {
    const session = getSession();
    if (!session) return { ok: false, status: 401, data: { detail: "Please log in first." } };
    headers.Authorization = `Bearer ${session.token}`;
  }

  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    console.error(err);
    return { ok: false, status: 0, data: { detail: "Couldn't reach the server. Check your connection." } };
  }

  let data = null;
  if (res.status !== 204) {
    try { data = await res.json(); } catch { /* empty or non-JSON body */ }
  }
  if (auth && res.status === 401) {
    clearSession();
    showToast("Your session has ended. Please log in again.");
  }
  return { ok: res.ok, status: res.status, data };
}

async function logIn(username, password) {
  const res = await api("/api/v1/auth/login", { method: "POST", body: { username, password } });
  if (!res.ok) return res;
  // expire the stored token a little early so it is never sent after the server stops accepting it
  saveSession({
    token: res.data.access_token,
    expiresAt: Date.now() + (res.data.expires_in - 30) * 1000,
    username,
  });
  const me = await api("/api/v1/users/me", { auth: true });
  if (me.ok) saveSession({ ...getSession(), username: me.data.username });
  await refreshProgress();
  renderAccountBar();
  return res;
}

async function signUp(username, password) {
  const res = await api("/api/v1/auth/register", { method: "POST", body: { username, password } });
  if (!res.ok) return res;
  return logIn(username, password);
}

function logOut() {
  clearSession();
  showToast("You've logged out.");
}

// Loads the player's EXP for every game mode.
async function refreshProgress() {
  if (!getSession()) { progressBySlug = {}; return; }
  const res = await api("/api/v1/users/me/progress", { auth: true });
  if (res.ok) {
    progressBySlug = Object.fromEntries(res.data.progress.map((p) => [p.slug, p.exp]));
    renderCategories();
    renderAccountBar();
  }
}

// Loldle scoring: fewer guesses earn more EXP. 1 guess = 10 of 10, 10 or more guesses = 1 of 10.
function guessScore(guessCount) {
  return { correct: Math.max(1, Math.min(10, 11 - guessCount)), total: 10 };
}

// Shows a reward message inside the result panel of `container`.
function setReward(container, html) {
  const el = container.querySelector("[data-reward]");
  if (el) el.innerHTML = html;
}

// Sends a finished game's score to the API. onUpdate(html) receives each message to show.
// The API works out the EXP itself, so the browser only reports the score.
async function awardExp(slug, correct, total, onUpdate) {
  if (!getSession()) {
    onUpdate(`<a href="#/login">Log in</a> or <a href="#/register">sign up</a> to earn EXP and level up.`);
    return;
  }
  onUpdate("Saving your progress…");
  const levelBefore = levelFor(progressBySlug[slug] || 0);
  const res = await api(`/api/v1/users/me/progress/${slug}`, {
    method: "PATCH",
    body: { correct_answers: correct, total_questions: total },
    auth: true,
  });
  if (!res.ok) {
    onUpdate(res.status === 401
      ? `Your session ended, so this game wasn't saved. <a href="#/login">Log in again</a>.`
      : `Couldn't save your progress: ${escapeHtml(errorMessage(res.data, "unknown error"))}`);
    return;
  }

  const { exp_gained: gained, exp, level } = res.data;
  progressBySlug[slug] = exp;
  renderCategories();
  renderAccountBar();
  const into = exp % EXP_PER_LEVEL;
  onUpdate(`<span class="reward-line"><strong>+${gained} EXP</strong> · Level ${level}${
    level > levelBefore ? ` <span class="level-up">Level up!</span>` : ""}</span>
    ${expBarHtml(into)}
    <span class="reward-next">${into} / ${EXP_PER_LEVEL} EXP to level ${level + 1}</span>`);
}

function expBarHtml(into) {
  return `<span class="exp-bar" role="img" aria-label="${into} of ${EXP_PER_LEVEL} EXP towards the next level"><span style="width:${into}%"></span></span>`;
}

let toastTimer;
function showToast(text) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3500);
}

// The strip at the top of every screen: guest links, or the signed-in player.
function renderAccountBar() {
  const el = document.getElementById("account-bar");
  if (!el) return;
  const session = getSession();
  if (!session) {
    el.innerHTML = `<span class="account-who">Playing as guest</span>
      <a class="account-link" href="#/login">Log in</a>
      <a class="btn btn-small" href="#/register">Sign up</a>`;
    return;
  }
  const total = Object.values(progressBySlug).reduce((sum, exp) => sum + exp, 0);
  el.innerHTML = `<span class="account-who">Signed in as <strong>${escapeHtml(session.username)}</strong> · ${total} EXP</span>
    <a class="account-link" href="#/account">My progress</a>
    <button type="button" class="account-link" data-action="logout">Log out</button>`;
  el.querySelector("[data-action=logout]").addEventListener("click", () => {
    logOut();
    if (location.hash === "#/account") location.hash = "#/";
  });
}

/* =====================================================
   SECTION 2: SHARED HELPERS
   ===================================================== */
function pickRandom(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function shuffle(list) {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// "Fighter / Assassin" -> ["Fighter", "Assassin"]
function splitMulti(value) {
  return value.split("/").map((part) => part.trim());
}

/* =====================================================
   SECTION 3: MODE LIST (set ready: true when a mode is built)
   ===================================================== */
const CATEGORIES = [
  {
    id: "loldle",
    name: "Loldle",
    blurb: "Find the secret champion from clues.",
    modes: [
      { name: "Classic", desc: "Guess champions and read the attribute tiles.", href: "#/loldle/classic", ready: true },
      { name: "Lore", desc: "Name the champion from their story.", href: "#/loldle/lore", ready: true },
    ],
  },
  {
    id: "quick",
    name: "Quick decisions",
    blurb: "One question, one click.",
    modes: [
      { name: "Higher or Lower", desc: "Which champion has the higher skill ceiling?", href: "#/quick/higher-lower", ready: true },
      { name: "Odd One Out", desc: "Three champions share something. Find the one that doesn't.", href: "#/quick/odd-one-out", ready: true },
      { name: "True or False", desc: "Judge a statement about a champion.", href: "#/quick/true-false", ready: true },
    ],
  },
  {
    id: "matching",
    name: "Matching",
    blurb: "Put champions where they belong.",
    modes: [
      { name: "Match the Region", desc: "Sort champions into their home regions.", href: "#/matching/region", ready: true },
      { name: "Lore Match", desc: "Pair each story with its champion.", href: "#/matching/lore", ready: true },
      { name: "Role Sort", desc: "Drop each champion into the right role, against the clock.", href: "#/matching/role", ready: true },
    ],
  },
];

/* =====================================================
   SECTION 4: HUB + ROUTER
   Each game is a function startX(root) that fills `root`.
   The URL hash picks the screen, so the back button works.
   ===================================================== */
const hubScreen = document.getElementById("hub-screen");
const gameScreen = document.getElementById("game-screen");
const categoriesEl = document.getElementById("categories");
const statusEl = document.getElementById("api-status");

// Register a game here when you build it. Key = hash without "#/".
const GAMES = {
  "loldle/classic": startClassic,
  "loldle/lore": startLore,
  "quick/higher-lower": startHigherLower,
  "quick/odd-one-out": startOddOneOut,
  "quick/true-false": startTrueFalse,
  "matching/region": startMatchRegion,
  "matching/lore": startMatchLore,
  "matching/role": startMatchRole,
};

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]
  ));
}

// Level badge on a mode card, shown only when someone is logged in.
function modeLevelHtml(href) {
  if (!getSession()) return "";
  const exp = progressBySlug[href.slice(2)] || 0;
  return `<span class="mode-level" title="${exp} EXP">Lv ${levelFor(exp)}</span>`;
}

function renderCategories() {
  categoriesEl.innerHTML = CATEGORIES.map((cat, ci) => `
    <section class="category" data-cat="${cat.id}" aria-labelledby="h-${cat.id}">
      <div class="category-head">
        <h2 id="h-${cat.id}">${cat.name}</h2>
        <p>${cat.blurb}</p>
      </div>
      <ul class="modes">
        ${cat.modes.map((m, i) => m.ready
          ? `<li style="--i:${ci * 3 + i}"><a class="mode mode-card" href="${m.href}">${modeLevelHtml(m.href)}<span class="mode-name">${m.name}</span><span class="mode-desc">${m.desc}</span><span class="mode-state">Play <span class="arrow" aria-hidden="true">→</span></span></a></li>`
          : `<li style="--i:${ci * 3 + i}"><div class="mode mode-card is-locked"><span class="mode-name">${m.name}</span><span class="mode-desc">${m.desc}</span><span class="mode-state">Not built yet</span></div></li>`
        ).join("")}
      </ul>
    </section>`).join("");
}

// Try to load one portrait so a broken image setup is obvious instead of silent.
function checkImages(roster) {
  const el = document.getElementById("image-status");
  const url = roster.length ? imageUrl(roster[0]) : null;
  if (!url) {
    el.textContent = "The roster has no image paths, so portraits will show initials.";
    el.dataset.state = "error";
    return;
  }
  const probe = new Image();
  probe.onload = () => { el.textContent = "Images are loading"; el.dataset.state = "ok"; };
  probe.onerror = () => {
    el.innerHTML = `Images aren't loading. Put the champion images in an "images" folder next to index.html. The first one should be at <code>${escapeHtml(url)}</code>.`;
    el.dataset.state = "error";
    console.error("Image failed to load:", url);
  };
  probe.src = url;
}

async function checkApi() {
  try {
    const roster = await getRoster();
    statusEl.textContent = `${roster.length} champions loaded`;
    statusEl.dataset.state = "ok";
    checkImages(roster);
  } catch (err) {
    statusEl.textContent = "Couldn't reach the API. Check your connection or the API key, then reload.";
    statusEl.dataset.state = "error";
    console.error(err);
  }
}

// Account pages, routed the same way as games.
const PAGES = {
  login: (root) => startAuth(root, "login"),
  register: (root) => startAuth(root, "register"),
  account: startAccount,
};

function route() {
  const key = location.hash.replace(/^#\//, "");
  const start = GAMES[key] || PAGES[key];
  gameScreen.innerHTML = "";
  if (start) {
    gameScreen.dataset.cat = GAMES[key] ? key.split("/")[0] : "account";
    hubScreen.hidden = true;
    gameScreen.hidden = false;
    window.scrollTo(0, 0);
    start(gameScreen);
  } else {
    hubScreen.hidden = false;
    gameScreen.hidden = true;
  }
}

/* =====================================================
   SECTION 5: SHARED LOLDLE PIECES
   Used by both Classic and Lore.
   ===================================================== */
function portraitHtml(champ, size = "sm") {
  const src = imageUrl(champ);
  return `<span class="portrait portrait-${size}" data-initial="${escapeHtml(champ.name[0])}">${
    src ? `<img src="${escapeHtml(src)}" alt="" loading="lazy">` : ""
  }</span>`;
}

// A missing image falls back to the initial letter behind it.
function watchBrokenImages(root) {
  root.addEventListener("error", (e) => {
    if (e.target.tagName === "IMG") e.target.classList.add("broken");
  }, true);
}

// Load the roster into a game screen. Returns null (and shows an error) if it fails,
// or if the player left the page while it was loading.
async function loadRosterFor(root, hash) {
  root.innerHTML = `<p class="loading" role="status">Loading roster…</p>`;
  let roster;
  try {
    roster = await getRoster();
  } catch (err) {
    console.error(err);
    root.innerHTML = `<a class="back" href="#/">Back to games</a>
      <p class="error">Couldn't load the roster. Check the API and reload the page.</p>`;
    return null;
  }
  return location.hash === hash ? roster : null;
}

function pickNewSecret(roster, previous) {
  let next;
  do { next = pickRandom(roster); } while (roster.length > 1 && previous && next.id === previous.id);
  return next;
}

// "You found X" / "It was X" panel shown when a round ends.
function resultPanelHtml(secret, status, guessCount) {
  const headline = status === "won" ? `You found ${escapeHtml(secret.name)}` : `It was ${escapeHtml(secret.name)}`;
  const detail = status === "won"
    ? `${guessCount} ${guessCount === 1 ? "guess" : "guesses"}`
    : escapeHtml(secret.title);
  return `<div class="result" data-status="${status}">
    ${portraitHtml(secret, "lg")}
    <div class="result-text"><h2>${headline}</h2><p>${detail}</p>
      <p class="reward" data-reward>${status === "won" ? "" : "Revealing the answer earns no EXP."}</p></div>
    <button type="button" class="btn" data-action="new-game">New game</button>
  </div>`;
}

// Search box with a dropdown of matching champions.
// Returns { el, focus(), setDisabled(bool), setExcluded(ids) }. onPick(champion) fires on selection.
function createPicker(roster, onPick) {
  const el = document.createElement("div");
  el.className = "combo";
  el.innerHTML = `
    <label class="sr-only" for="guess-input">Champion name</label>
    <input id="guess-input" type="text" autocomplete="off" spellcheck="false"
      placeholder="Type a champion name"
      role="combobox" aria-expanded="false" aria-controls="guess-list" aria-autocomplete="list">
    <ul id="guess-list" class="options" role="listbox" hidden></ul>`;
  const input = el.querySelector("input");
  const list = el.querySelector("ul");

  let excluded = new Set();
  let matches = [];
  let active = -1;

  function close() {
    list.hidden = true;
    matches = [];
    active = -1;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
  }

  function open(query) {
    const q = query.toLowerCase();
    matches = roster
      .filter((c) => !excluded.has(c.id) && c.name.toLowerCase().includes(q))
      .sort((a, b) => {
        const aStart = a.name.toLowerCase().startsWith(q) ? 0 : 1;
        const bStart = b.name.toLowerCase().startsWith(q) ? 0 : 1;
        return aStart - bStart || a.name.localeCompare(b.name);
      })
      .slice(0, 8);
    active = matches.length ? 0 : -1;

    list.innerHTML = matches.length
      ? matches.map((c, i) => `<li id="opt-${i}" role="option" data-id="${c.id}" aria-selected="${i === active}">
          ${portraitHtml(c, "md")}<span>${escapeHtml(c.name)}</span></li>`).join("")
      : `<li class="no-match">No champion matches "${escapeHtml(query)}"</li>`;
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
    if (active >= 0) input.setAttribute("aria-activedescendant", "opt-0");
  }

  function move(step) {
    if (!matches.length) return;
    active = (active + step + matches.length) % matches.length;
    list.querySelectorAll("[role=option]").forEach((li, i) => li.setAttribute("aria-selected", String(i === active)));
    input.setAttribute("aria-activedescendant", `opt-${active}`);
    list.querySelector(`#opt-${active}`).scrollIntoView({ block: "nearest" });
  }

  function pick(champ) {
    if (!champ) return;
    input.value = "";
    close();
    onPick(champ);
  }

  input.addEventListener("input", () => {
    const q = input.value.trim();
    q ? open(q) : close();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
    else if (e.key === "Enter" && active >= 0) { e.preventDefault(); pick(matches[active]); }
    else if (e.key === "Escape") close();
  });
  // mousedown (not click) so it fires before the input loses focus
  list.addEventListener("mousedown", (e) => {
    const li = e.target.closest("[role=option]");
    if (!li) return;
    e.preventDefault();
    pick(roster.find((c) => c.id === Number(li.dataset.id)));
  });
  input.addEventListener("blur", close);

  return {
    el,
    focus: () => input.focus(),
    setDisabled: (off) => { input.disabled = off; if (off) close(); },
    setExcluded: (ids) => { excluded = new Set(ids); },
  };
}

/* =====================================================
   SECTION 6: LOLDLE - CLASSIC
   ===================================================== */
// One entry per feedback column. `kind` decides how a guess is compared.
const CLASSIC_COLUMNS = [
  { key: "role", label: "Role", kind: "multi" },
  { key: "region", label: "Region", kind: "multi" },
  { key: "playstyle", label: "Playstyle", kind: "single" },
  { key: "damage_type", label: "Damage", kind: "single" },
  { key: "attack_type", label: "Attack", kind: "single" },
  { key: "mobility", label: "Mobility", kind: "ordered", order: ["Low", "Medium", "High"] },
  { key: "difficulty", label: "Difficulty", kind: "ordered", order: ["Easy", "Medium", "Hard"] },
  { key: "skill_ceiling", label: "Skill ceiling", kind: "number" },
  { key: "year_released", label: "Released", kind: "number" },
];

// "The Void" and "Void" should count as the same region.
function normalizePart(part) {
  return part.replace(/^the\s+/i, "").toLowerCase();
}

// Compare one attribute of a guess against the answer.
// Returns { state: "correct" | "partial" | "wrong", dir?: "higher" | "lower" }.
// dir describes the ANSWER relative to the guess.
function compareField(col, guess, answer) {
  const g = guess[col.key];
  const a = answer[col.key];

  if (col.kind === "multi") {
    const gParts = splitMulti(g).map(normalizePart);
    const aParts = splitMulti(a).map(normalizePart);
    const shared = gParts.filter((p) => aParts.includes(p)).length;
    if (shared === gParts.length && shared === aParts.length) return { state: "correct" };
    return { state: shared > 0 ? "partial" : "wrong" };
  }

  if (col.kind === "single") {
    return { state: g === a ? "correct" : "wrong" };
  }

  // "ordered" (labels with a rank) and "number" (already numeric)
  const gv = col.kind === "ordered" ? col.order.indexOf(g) : g;
  const av = col.kind === "ordered" ? col.order.indexOf(a) : a;
  if (gv === av) return { state: "correct" };
  return { state: "wrong", dir: av > gv ? "higher" : "lower" };
}

function renderTile(col, guess, answer, i) {
  const r = compareField(col, guess, answer);
  const mark = { correct: "✓", partial: "~", wrong: "✕" }[r.state];
  const arrow = r.dir === "higher" ? "▲" : r.dir === "lower" ? "▼" : "";
  const hint = r.dir ? `, answer is ${r.dir}` : "";
  const label = `${col.label}: ${guess[col.key]}, ${r.state}${hint}`;
  return `<div class="tile" data-state="${r.state}" style="--i:${i}" role="img" aria-label="${escapeHtml(label)}">
    <span class="mark" aria-hidden="true">${mark}</span>
    <span class="val">${escapeHtml(guess[col.key])}${arrow ? ` <span class="dir" aria-hidden="true">${arrow}</span>` : ""}</span>
  </div>`;
}

async function startClassic(root) {
  const roster = await loadRosterFor(root, "#/loldle/classic");
  if (!roster) return;

  let secret = pickRandom(roster);
  let guesses = [];          // champion objects, oldest first
  let status = "playing";    // "playing" | "won" | "gaveUp"

  root.innerHTML = `
    <a class="back" href="#/">Back to games</a>
    <header class="game-head">
      <h1>Classic</h1>
      <p>Guess the secret champion. Each guess shows how close it is.</p>
    </header>
    <ul class="legend" aria-label="Tile colours">
      <li><span class="swatch" data-state="correct">✓</span> Exact match</li>
      <li><span class="swatch" data-state="partial">~</span> Shares some values</li>
      <li><span class="swatch" data-state="wrong">✕</span> No match</li>
      <li><span class="swatch" data-state="wrong">▲▼</span> Answer is higher or lower</li>
    </ul>
    <div class="guess-bar">
      <div id="picker-slot"></div>
      <button type="button" id="give-up" class="btn-quiet">Reveal answer</button>
    </div>
    <p id="counter" class="counter" role="status"></p>
    <div id="result"></div>
    <div class="board-scroll"><div id="board" class="board"></div></div>
  `;
  watchBrokenImages(root);

  const picker = createPicker(roster, makeGuess);
  root.querySelector("#picker-slot").replaceWith(picker.el);
  const board = root.querySelector("#board");
  const result = root.querySelector("#result");
  const counter = root.querySelector("#counter");
  const giveUpBtn = root.querySelector("#give-up");

  function makeGuess(champ) {
    if (status !== "playing") return;
    guesses.push(champ);
    if (champ.id === secret.id) status = "won";
    render();
    if (status === "playing") picker.focus();
    if (status === "won") {
      const round = secret;
      const { correct, total } = guessScore(guesses.length);
      awardExp("loldle/classic", correct, total, (html) => { if (secret === round) setReward(result, html); });
    }
  }

  function newGame() {
    secret = pickNewSecret(roster, secret);
    guesses = [];
    status = "playing";
    render();
    picker.focus();
  }

  giveUpBtn.addEventListener("click", () => {
    if (status !== "playing") return;
    status = "gaveUp";
    render();
  });

  function renderBoard() {
    if (!guesses.length) {
      board.innerHTML = `<p class="empty">Your guesses will show up here. Pick any champion to start.</p>`;
      return;
    }
    const head = `<div class="row row-head"><div>Champion</div>${
      CLASSIC_COLUMNS.map((c) => `<div>${c.label}</div>`).join("")}</div>`;
    const rows = guesses.slice().reverse().map((g, idx) => `
      <div class="row${idx === 0 ? " fresh" : ""}">
        <div class="cell-champ">${portraitHtml(g, "md")}<span>${escapeHtml(g.name)}</span></div>
        ${CLASSIC_COLUMNS.map((c, i) => renderTile(c, g, secret, i)).join("")}
      </div>`).join("");
    board.innerHTML = head + rows;
  }

  function render() {
    const playing = status === "playing";
    picker.setDisabled(!playing);
    picker.setExcluded(guesses.map((g) => g.id));
    giveUpBtn.hidden = !playing;
    counter.textContent = guesses.length
      ? `${guesses.length} ${guesses.length === 1 ? "guess" : "guesses"} so far`
      : "";
    renderBoard();
    result.innerHTML = playing ? "" : resultPanelHtml(secret, status, guesses.length);
    const again = result.querySelector("[data-action=new-game]");
    if (again) again.addEventListener("click", newGame);
  }

  render();
  picker.focus();
}

/* =====================================================
   SECTION 7: LOLDLE - LORE
   Shows the champion's lore with their name hidden.
   Every wrong guess unlocks one more clue.
   ===================================================== */
const REDACTION = "█████";

// Other names a champion's lore uses for them. Add more here if you spot a leak.
const LORE_ALIASES = {
  Pantheon: ["Atreus"],
  Mordekaiser: ["Sahn-Uzal"],
};

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Everything that would give the champion away: full name, each long word of it, known aliases.
function secretTerms(champ) {
  const terms = new Set([champ.name, ...(LORE_ALIASES[champ.name] || [])]);
  champ.name.split(/\s+/)
    .filter((word) => word.replace(/\W/g, "").length >= 4)
    .forEach((word) => terms.add(word));
  return [...terms].sort((a, b) => b.length - a.length); // longest first
}

function maskName(text, champ) {
  // an apostrophe in a name should also match the curly version
  const pattern = secretTerms(champ).map((t) => escapeRegex(t).replace(/'/g, "['’]")).join("|");
  return text.replace(new RegExp(`(?<!\\w)(?:${pattern})(?!\\w)`, "gi"), REDACTION);
}

// Split into sentences, without cutting after the "Dr." in "Dr. Mundo".
function splitSentences(text) {
  return text.split(/(?<=[.!?])(?<!\bDr\.)\s+(?=[A-Z])/).map((s) => s.trim()).filter(Boolean);
}

// Ordered clue list: each sentence of the lore (name hidden), then the title.
function buildClues(champ) {
  const clues = splitSentences(maskName(champ.lore || "", champ)).map((text) => ({ kind: "lore", text }));
  if (champ.title) clues.push({ kind: "title", text: maskName(champ.title, champ) });
  return clues;
}

// Escape text, then turn each hidden name into a visible "redacted" block.
function clueHtml(text) {
  return escapeHtml(text).split(REDACTION).join(
    `<span class="redacted" role="img" aria-label="hidden champion name">${REDACTION}</span>`
  );
}

async function startLore(root) {
  const roster = await loadRosterFor(root, "#/loldle/lore");
  if (!roster) return;

  let secret = pickRandom(roster);
  let clues = buildClues(secret);
  let wrong = [];            // wrong guesses, oldest first
  let status = "playing";    // "playing" | "won" | "gaveUp"
  let guessCount = 0;

  root.innerHTML = `
    <a class="back" href="#/">Back to games</a>
    <header class="game-head">
      <h1>Lore</h1>
      <p>Who is this champion? Their name is hidden. Each wrong guess unlocks another clue.</p>
    </header>
    <div class="guess-bar">
      <div id="picker-slot"></div>
      <button type="button" id="give-up" class="btn-quiet">Reveal answer</button>
    </div>
    <p id="counter" class="counter" role="status"></p>
    <div id="result"></div>
    <article id="lore-card" class="lore-card"></article>
    <section id="wrong-section" class="wrong-section" aria-label="Wrong guesses"></section>
  `;
  watchBrokenImages(root);

  const picker = createPicker(roster, makeGuess);
  root.querySelector("#picker-slot").replaceWith(picker.el);
  const card = root.querySelector("#lore-card");
  const wrongSection = root.querySelector("#wrong-section");
  const result = root.querySelector("#result");
  const counter = root.querySelector("#counter");
  const giveUpBtn = root.querySelector("#give-up");

  function makeGuess(champ) {
    if (status !== "playing") return;
    guessCount++;
    if (champ.id === secret.id) status = "won";
    else wrong.push(champ);
    render();
    if (status === "playing") picker.focus();
    if (status === "won") {
      const round = secret;
      const { correct, total } = guessScore(guessCount);
      awardExp("loldle/lore", correct, total, (html) => { if (secret === round) setReward(result, html); });
    }
  }

  function newGame() {
    secret = pickNewSecret(roster, secret);
    clues = buildClues(secret);
    wrong = [];
    guessCount = 0;
    status = "playing";
    render();
    picker.focus();
  }

  giveUpBtn.addEventListener("click", () => {
    if (status !== "playing") return;
    status = "gaveUp";
    render();
  });

  function renderCard() {
    if (status !== "playing") {
      // round is over: show the full, unmasked story
      card.innerHTML = `<p class="lore-text">${escapeHtml(secret.lore || "")}</p>
        ${secret.title ? `<p class="lore-title">${escapeHtml(secret.title)}</p>` : ""}`;
      return;
    }
    const shown = Math.min(1 + wrong.length, clues.length);
    const visible = clues.slice(0, shown);
    const loreText = visible.filter((c) => c.kind === "lore").map((c) => clueHtml(c.text)).join(" ");
    const title = visible.find((c) => c.kind === "title");
    const locked = clues.length - shown;
    card.innerHTML = `
      <p class="clue-count">Clue ${shown} of ${clues.length}</p>
      <p class="lore-text">${loreText}</p>
      ${title ? `<p class="lore-title">Known as: ${clueHtml(title.text)}</p>` : ""}
      <p class="locked">${locked > 0
        ? `${locked} more ${locked === 1 ? "clue" : "clues"} locked. A wrong guess unlocks the next one.`
        : "All clues unlocked."}</p>`;
  }

  function renderWrong() {
    wrongSection.innerHTML = wrong.length
      ? `<h2>Not these</h2><ul class="wrong-list">${wrong.map((c) =>
          `<li>${portraitHtml(c, "md")}<span>${escapeHtml(c.name)}</span><span class="wrong-x" aria-hidden="true">✕</span></li>`).join("")}</ul>`
      : "";
  }

  function render() {
    const playing = status === "playing";
    picker.setDisabled(!playing);
    picker.setExcluded(wrong.map((c) => c.id));
    giveUpBtn.hidden = !playing;
    counter.textContent = wrong.length
      ? `${wrong.length} wrong ${wrong.length === 1 ? "guess" : "guesses"}`
      : "";
    renderCard();
    renderWrong();
    result.innerHTML = playing ? "" : resultPanelHtml(secret, status, guessCount);
    const again = result.querySelector("[data-action=new-game]");
    if (again) again.addEventListener("click", newGame);
  }

  render();
  picker.focus();
}

/* =====================================================
   SECTION 8: QUICK DECISIONS
   One shared runner (startQuiz) plus one question maker per game.
   A question maker returns a "round":
     { prompt, visual?, layout: "pair" | "grid" | "binary",
       options: [{ html, correct }], explain }
   ===================================================== */
const ROUNDS_PER_GAME = 10;

// Champions not used yet this game. If too few are left, start over with everyone.
function freshPool(roster, used, minimum) {
  const pool = roster.filter((c) => !used.has(c.id));
  if (pool.length >= minimum) return pool;
  used.clear();
  return roster;
}

// The values a champion has for an attribute, e.g. "Fighter / Assassin" -> two values.
function tokensOf(champ, attr) {
  if (attr.multi) {
    return splitMulti(champ[attr.key]).map((part) => ({
      norm: normalizePart(part),
      label: part.replace(/^the\s+/i, ""),
    }));
  }
  const value = String(champ[attr.key]);
  return [{ norm: value.toLowerCase(), label: value }];
}

function championCardHtml(champ) {
  return `${portraitHtml(champ, "xl")}<span class="opt-name">${escapeHtml(champ.name)}</span>`;
}

async function startQuiz(root, { hash, title, intro, makeRound }) {
  const roster = await loadRosterFor(root, hash);
  if (!roster) return;

  root.innerHTML = `
    <a class="back" href="#/">Back to games</a>
    <header class="game-head"><h1>${title}</h1><p>${intro}</p></header>
    <div id="quiz"></div>`;
  watchBrokenImages(root);
  const quiz = root.querySelector("#quiz");

  let rounds = [];
  let index = 0;
  let score = 0;
  let answered = null;       // index of the chosen option, or null

  function newRun() {
    const used = new Set();
    rounds = Array.from({ length: ROUNDS_PER_GAME }, () => makeRound(roster, used));
    index = 0;
    score = 0;
    renderRound();
  }

  function renderRound() {
    const round = rounds[index];
    answered = null;
    quiz.innerHTML = `
      <p id="progress" class="quiz-progress" role="status">Question ${index + 1} of ${ROUNDS_PER_GAME} · Score ${score}</p>
      ${round.visual ? `<div class="quiz-visual">${round.visual}</div>` : ""}
      <h2 class="quiz-prompt">${round.prompt}</h2>
      <div class="quiz-options" data-layout="${round.layout}">
        ${round.options.map((o, i) => `<button type="button" class="quiz-option" data-i="${i}" style="--i:${i}">${o.html}<span class="quiz-mark" aria-hidden="true"></span></button>`).join("")}
      </div>
      <div id="feedback" class="quiz-feedback" aria-live="polite"></div>`;
    quiz.querySelectorAll(".quiz-option").forEach((btn) => {
      btn.addEventListener("click", () => answer(Number(btn.dataset.i)));
    });
  }

  function answer(i) {
    if (answered !== null) return;
    answered = i;
    const round = rounds[index];
    const right = round.options[i].correct;
    if (right) score++;

    quiz.querySelectorAll(".quiz-option").forEach((btn, k) => {
      const isCorrect = round.options[k].correct;
      btn.setAttribute("aria-disabled", "true");
      btn.dataset.state = isCorrect ? "correct" : k === i ? "wrong" : "dim";
      btn.querySelector(".quiz-mark").textContent = isCorrect ? "✓" : k === i ? "✕" : "";
    });
    quiz.querySelector("#progress").textContent =
      `Question ${index + 1} of ${ROUNDS_PER_GAME} · Score ${score}`;

    const last = index === ROUNDS_PER_GAME - 1;
    const feedback = quiz.querySelector("#feedback");
    feedback.innerHTML = `
      <p class="quiz-verdict" data-good="${right}">${right ? "Correct." : "Not quite."}</p>
      <p class="quiz-explain">${round.explain}</p>
      <button type="button" class="btn" id="next">${last ? "See results" : "Next question"}</button>`;
    const next = feedback.querySelector("#next");
    next.addEventListener("click", () => { last ? renderEnd() : (index++, renderRound()); });
    next.focus();
  }

  function renderEnd() {
    const verdict = score >= 9 ? "Superb." : score >= 7 ? "Nicely done." : score >= 5 ? "Not bad." : "Room to improve.";
    quiz.innerHTML = `<div class="result" data-status="won">
      <div class="result-text"><h2>${score} out of ${ROUNDS_PER_GAME}</h2><p>${verdict}</p>
        <p class="reward" data-reward></p></div>
      <button type="button" class="btn" id="again">Play again</button>
    </div>`;
    const again = quiz.querySelector("#again");
    again.addEventListener("click", newRun);
    again.focus();
    const run = rounds;
    awardExp(hash.slice(2), score, ROUNDS_PER_GAME, (html) => { if (rounds === run) setReward(quiz, html); });
  }

  newRun();
}

/* ---------- Higher or Lower ---------- */
const HL_STATS = [
  { key: "skill_ceiling", label: "Skill ceiling", question: "has the higher skill ceiling" },
  { key: "skill_floor", label: "Skill floor", question: "has the higher skill floor" },
  { key: "year_released", label: "Release year", question: "was released more recently" },
];

function makeHigherLowerRound(roster, used) {
  const stat = pickRandom(HL_STATS);
  let pair = null;
  for (let i = 0; i < 60 && !pair; i++) {
    const [a, b] = shuffle(freshPool(roster, used, 2));
    if (a[stat.key] !== b[stat.key]) pair = [a, b];
  }
  while (!pair) { // fresh champions kept tying: fall back to anyone
    const [a, b] = shuffle(roster);
    if (a[stat.key] !== b[stat.key]) pair = [a, b];
  }
  pair.forEach((c) => used.add(c.id));
  const winner = pair[0][stat.key] > pair[1][stat.key] ? pair[0] : pair[1];

  return {
    prompt: `Which champion ${stat.question}?`,
    layout: "pair",
    options: pair.map((c) => ({ html: championCardHtml(c), correct: c === winner, champ: c })),
    explain: `${stat.label}: ${pair.map((c) => `${escapeHtml(c.name)} ${c[stat.key]}`).join(", ")}.`,
    meta: { kind: "higher-lower", key: stat.key },
  };
}

function startHigherLower(root) {
  return startQuiz(root, {
    hash: "#/quick/higher-lower",
    title: "Higher or Lower",
    intro: "Two champions, one question. Pick the right one.",
    makeRound: makeHigherLowerRound,
  });
}

/* ---------- Odd One Out ---------- */
const ODD_ATTRIBUTES = [
  { key: "role", label: "role", multi: true },
  { key: "region", label: "region", multi: true },
  { key: "playstyle", label: "playstyle" },
  { key: "damage_type", label: "damage type" },
  { key: "attack_type", label: "attack type" },
  { key: "mobility", label: "mobility" },
  { key: "difficulty", label: "difficulty" },
];

function makeOddOneOutRound(roster, used) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const pool = attempt < 100 ? freshPool(roster, used, 8) : roster;
    const attr = pickRandom(ODD_ATTRIBUTES);

    // group the pool by each value of this attribute
    const groups = new Map(); // normalized value -> { label, champs }
    for (const c of pool) {
      for (const t of tokensOf(c, attr)) {
        if (!groups.has(t.norm)) groups.set(t.norm, { label: t.label, champs: [] });
        groups.get(t.norm).champs.push(c);
      }
    }
    const usable = [...groups.entries()].filter(([, g]) => g.champs.length >= 3);
    if (!usable.length) continue;

    const [norm, group] = pickRandom(usable);
    const odds = pool.filter((c) => !tokensOf(c, attr).some((t) => t.norm === norm));
    if (!odds.length) continue;

    const odd = pickRandom(odds);
    const four = shuffle([...shuffle(group.champs).slice(0, 3), odd]);
    four.forEach((c) => used.add(c.id));

    return {
      prompt: `Three of these champions have the ${attr.label} <strong>${escapeHtml(group.label)}</strong>. Which one doesn't?`,
      layout: "grid",
      options: four.map((c) => ({ html: championCardHtml(c), correct: c === odd, champ: c })),
      explain: `${four.map((c) => `${escapeHtml(c.name)}: ${escapeHtml(c[attr.key])}`).join("; ")}.`,
      meta: { kind: "odd-one-out", key: attr.key, multi: !!attr.multi, norm },
    };
  }
  throw new Error("Couldn't build an Odd One Out round");
}

function startOddOneOut(root) {
  return startQuiz(root, {
    hash: "#/quick/odd-one-out",
    title: "Odd One Out",
    intro: "Three champions share something. Find the one that doesn't.",
    makeRound: makeOddOneOutRound,
  });
}

/* ---------- True or False ---------- */
const article = (word) => (/^[aeiou]/i.test(word) ? "an" : "a");

const TF_ATTRIBUTES = [
  { key: "role", label: "role", multi: true, say: (n, v) => `${n} is ${article(v)} ${v}` },
  { key: "region", label: "region", multi: true, say: (n, v) => `${n} comes from ${v}` },
  { key: "playstyle", label: "playstyle", say: (n, v) => `${n}'s playstyle is ${v}` },
  { key: "damage_type", label: "damage type", say: (n, v) => `${n} deals ${v} damage` },
  { key: "attack_type", label: "attack type", say: (n, v) => `${n} is a ${v} champion` },
  { key: "mobility", label: "mobility", say: (n, v) => `${n} has ${v} mobility` },
  { key: "difficulty", label: "difficulty", say: (n, v) => `${n}'s difficulty is ${v}` },
  { key: "year_released", label: "release year", say: (n, v) => `${n} was released in ${v}` },
];

function makeTrueFalseRound(roster, used) {
  const champ = pickRandom(freshPool(roster, used, 1));
  used.add(champ.id);
  const attr = pickRandom(TF_ATTRIBUTES);
  const own = tokensOf(champ, attr);

  // every value this attribute takes across the roster, minus the ones this champion has
  const seen = new Map();
  for (const c of roster) for (const t of tokensOf(c, attr)) seen.set(t.norm, t.label);
  const wrongValues = [...seen.entries()]
    .filter(([norm]) => !own.some((o) => o.norm === norm))
    .map(([, label]) => label);

  const isTrue = wrongValues.length === 0 || Math.random() < 0.5;
  const value = isTrue ? pickRandom(own).label : pickRandom(wrongValues);

  return {
    visual: portraitHtml(champ, "xl"),
    prompt: `${escapeHtml(attr.say(champ.name, value))}.`,
    layout: "binary",
    options: [
      { html: "True", correct: isTrue },
      { html: "False", correct: !isTrue },
    ],
    explain: `${escapeHtml(champ.name)}'s ${attr.label}: ${escapeHtml(champ[attr.key])}.`,
    meta: { kind: "true-false", key: attr.key, champId: champ.id, value, isTrue },
  };
}

function startTrueFalse(root) {
  return startQuiz(root, {
    hash: "#/quick/true-false",
    title: "True or False",
    intro: "A statement about a champion. Is it true?",
    makeRound: makeTrueFalseRound,
  });
}

/* =====================================================
   SECTION 9: MATCHING
   One shared runner (startMatching) plus one board maker per game.
   Pick a card from the tray, then pick the place it belongs.
   A board maker returns:
     { items:   [{ id, html, accepts: [targetId, ...] }],
       targets: [{ id, html, capacity }] }
   ===================================================== */
function shortChampionHtml(champ) {
  return `${portraitHtml(champ, "lg")}<span class="match-name">${escapeHtml(champ.name)}</span>`;
}

async function startMatching(root, { hash, title, intro, makeBoard }) {
  const roster = await loadRosterFor(root, hash);
  if (!roster) return;

  root.innerHTML = `
    <a class="back" href="#/">Back to games</a>
    <header class="game-head"><h1>${title}</h1><p>${intro}</p></header>
    <div id="match"></div>`;
  watchBrokenImages(root);
  const mount = root.querySelector("#match");

  let board, placed, selected, mistakes, message, startedAt, finishedAt;
  let reward = "";          // EXP message for the finished board, kept across re-renders
  let animateIn = true;     // cards slide in on a fresh board only, not on every click
  let lastPlaced = null;    // id of the card just placed, so only it pops

  function newRun() {
    board = makeBoard(roster);
    placed = new Map();      // item id -> target id
    selected = null;
    mistakes = 0;
    message = "";
    startedAt = Date.now();
    finishedAt = null;
    reward = "";
    animateIn = true;
    lastPlaced = null;
    render();
  }

  function render() {
    const enter = animateIn, justId = lastPlaced;
    animateIn = false;
    lastPlaced = null;
    const done = placed.size === board.items.length;
    const remaining = board.items.filter((i) => !placed.has(i.id));
    const status = done ? "All placed."
      : message || (selected ? "Now choose where it belongs." : "Pick a card, then pick where it belongs.");

    mount.innerHTML = `
      <p class="match-status" role="status">${escapeHtml(status)} <span class="match-mistakes">Mistakes: ${mistakes}</span></p>
      ${done ? "" : `<div class="match-tray${enter ? " enter" : ""}" aria-label="Cards to place">${remaining.map((item, n) =>
        `<button type="button" class="match-item" data-kind="${item.kind || "champion"}" style="--i:${n}" data-id="${escapeHtml(item.id)}" aria-pressed="${selected === item.id}">${item.html}</button>`
      ).join("")}</div>`}
      <div class="match-targets">${board.targets.map((t) => {
        const inside = board.items.filter((i) => placed.get(i.id) === t.id);
        const full = inside.length >= t.capacity;
        return `<div class="match-target">
          <button type="button" class="match-target-btn" data-id="${escapeHtml(t.id)}"${full ? ' aria-disabled="true"' : ""}>${t.html}</button>
          <div class="match-placed">${inside.map((i) => `<div class="match-chip${i.id === justId ? " just" : ""}">${i.html}</div>`).join("")}</div>
        </div>`;
      }).join("")}</div>
      ${done ? (() => {
        const secs = Math.round((finishedAt - startedAt) / 1000);
        return `<div class="result" data-status="won">
          <div class="result-text"><h2>All matched</h2>
          <p>${mistakes === 0 ? "No mistakes" : `${mistakes} ${mistakes === 1 ? "mistake" : "mistakes"}`} in ${secs} seconds.</p>
          <p class="reward" data-reward>${reward}</p></div>
          <button type="button" class="btn" id="again">Play again</button></div>`;
      })() : ""}`;
  }

  // find a button by its data-id without building a selector (ids can contain spaces)
  const byId = (selector, id) => [...mount.querySelectorAll(selector)].find((el) => el.dataset.id === id);

  function focusItem(id) {
    const el = id ? byId(".match-item", id) : mount.querySelector(".match-item");
    if (el) el.focus();
  }

  mount.addEventListener("click", (e) => {
    const again = e.target.closest("#again");
    if (again) { newRun(); focusItem(null); return; }

    const itemBtn = e.target.closest(".match-item");
    if (itemBtn) {
      selected = selected === itemBtn.dataset.id ? null : itemBtn.dataset.id;
      message = "";
      render();
      focusItem(selected || itemBtn.dataset.id);
      return;
    }

    const targetBtn = e.target.closest(".match-target-btn");
    if (!targetBtn || targetBtn.getAttribute("aria-disabled") === "true") return;
    if (!selected) { message = "Pick a card from the tray first."; render(); return; }

    const item = board.items.find((i) => i.id === selected);
    const targetId = targetBtn.dataset.id;
    if (item.accepts.includes(targetId)) {
      placed.set(item.id, targetId);
      lastPlaced = item.id;
      selected = null;
      message = "";
      if (placed.size === board.items.length) finishedAt = Date.now();
      render();
      if (finishedAt) {
        mount.querySelector("#again").focus();
        // every mistake costs one correct answer
        const run = board;
        const total = board.items.length;
        awardExp(hash.slice(2), Math.max(0, total - mistakes), total, (html) => {
          if (board !== run) return;
          reward = html;
          setReward(mount, html);
        });
      } else focusItem(null);
    } else {
      mistakes++;
      message = "Not there. Try another place.";
      render();
      focusItem(selected);
      const bad = byId(".match-target-btn", targetId);
      if (bad) { bad.dataset.flash = "wrong"; setTimeout(() => bad.removeAttribute("data-flash"), 700); }
    }
  });

  newRun();
}

// Pick up to `count` values from a list, at random.
const sample = (list, count) => shuffle(list).slice(0, count);

/* ---------- Match the Region ---------- */
function makeRegionBoard(roster) {
  const attr = { key: "region", multi: true };
  // only champions from a single region, so each card has exactly one right answer
  const groups = new Map(); // normalized region -> { label, champs }
  for (const c of roster) {
    const tokens = tokensOf(c, attr);
    if (tokens.length !== 1) continue;
    const { norm, label } = tokens[0];
    if (!groups.has(norm)) groups.set(norm, { label, champs: [] });
    groups.get(norm).champs.push(c);
  }
  const chosen = sample([...groups.entries()].filter(([, g]) => g.champs.length >= 2), 3);
  const items = [];
  const targets = [];
  for (const [norm, group] of chosen) {
    targets.push({ id: norm, html: `<span class="target-title">${escapeHtml(group.label)}</span>`, capacity: Infinity });
    for (const c of sample(group.champs, 2 + Math.floor(Math.random() * 2))) {
      items.push({ id: `c${c.id}`, html: shortChampionHtml(c), accepts: [norm], champ: c });
    }
  }
  return { items: shuffle(items), targets };
}

function startMatchRegion(root) {
  return startMatching(root, {
    hash: "#/matching/region",
    title: "Match the Region",
    intro: "Sort each champion into the region they come from.",
    makeBoard: makeRegionBoard,
  });
}

/* ---------- Role Sort ---------- */
function makeRoleBoard(roster) {
  const attr = { key: "role", multi: true };
  const counts = new Map(); // normalized role -> { label, count }
  for (const c of roster) {
    for (const t of tokensOf(c, attr)) {
      if (!counts.has(t.norm)) counts.set(t.norm, { label: t.label, count: 0 });
      counts.get(t.norm).count++;
    }
  }
  const candidates = [...counts.entries()].filter(([, r]) => r.count >= 3);

  // champions that fit this role and none of the other chosen roles
  const fitsFor = (norm, chosenNorms) => roster.filter((c) => {
    const mine = tokensOf(c, attr).map((t) => t.norm).filter((n) => chosenNorms.includes(n));
    return mine.length === 1 && mine[0] === norm;
  });

  // keep drawing three roles until each has at least two champions that fit only it
  let chosen = sample(candidates, 3);
  for (let i = 0; i < 100; i++) {
    const norms = chosen.map(([norm]) => norm);
    if (chosen.every(([norm]) => fitsFor(norm, norms).length >= 2)) break;
    chosen = sample(candidates, 3);
  }
  const chosenNorms = chosen.map(([norm]) => norm);

  const items = [];
  const targets = [];
  for (const [norm, role] of chosen) {
    targets.push({ id: norm, html: `<span class="target-title">${escapeHtml(role.label)}</span>`, capacity: Infinity });
    for (const c of sample(fitsFor(norm, chosenNorms), 2 + Math.floor(Math.random() * 2))) {
      items.push({ id: `c${c.id}`, html: shortChampionHtml(c), accepts: [norm], champ: c });
    }
  }
  return { items: shuffle(items), targets };
}

function startMatchRole(root) {
  return startMatching(root, {
    hash: "#/matching/role",
    title: "Role Sort",
    intro: "Drop each champion into its role. Some champions have two roles, so only the three roles shown count.",
    makeBoard: makeRoleBoard,
  });
}

/* ---------- Lore Match ---------- */
function makeLoreBoard(roster) {
  const picks = sample(roster, 5);
  const items = picks.map((c) => {
    const snippet = buildClues(c).filter((x) => x.kind === "lore").slice(0, 2).map((x) => x.text).join(" ");
    return { id: `c${c.id}`, html: `<span class="snippet">${clueHtml(snippet)}</span>`, accepts: [`c${c.id}`], champ: c, kind: "text" };
  });
  const targets = shuffle(picks).map((c) => ({ id: `c${c.id}`, html: shortChampionHtml(c), capacity: 1 }));
  return { items: shuffle(items), targets };
}

function startMatchLore(root) {
  return startMatching(root, {
    hash: "#/matching/lore",
    title: "Lore Match",
    intro: "Each story has its champion's name hidden. Pair every story with the right champion.",
    makeBoard: makeLoreBoard,
  });
}

/* =====================================================
   SECTION 10: ACCOUNT PAGES
   #/login, #/register and #/account (progress + delete account)
   ===================================================== */

// Same rules as the API's RegisterRequest, checked first so mistakes show instantly.
function signUpProblem(username, password, confirm) {
  if (username.length < 3 || username.length > 50) return "Your username must be 3 to 50 characters.";
  if (!/^[A-Za-z0-9_]+$/.test(username)) return "Your username can only use letters, numbers and underscores.";
  if (password.length < 8) return "Your password must be at least 8 characters.";
  if (password.length > 128) return "Your password can be at most 128 characters.";
  if (password !== confirm) return "The two passwords don't match.";
  return "";
}

function startAuth(root, mode) {
  const isLogin = mode === "login";
  const session = getSession();
  if (session) {
    root.innerHTML = `<a class="back" href="#/">Back to games</a>
      <header class="game-head"><h1>You're signed in</h1>
        <p>You're already logged in as <strong>${escapeHtml(session.username)}</strong>.</p></header>
      <a class="btn" href="#/account">See my progress</a>`;
    return;
  }

  root.innerHTML = `
    <a class="back" href="#/">Back to games</a>
    <header class="game-head">
      <h1>${isLogin ? "Log in" : "Sign up"}</h1>
      <p>${isLogin
        ? "Welcome back. Log in to keep earning EXP."
        : "Create an account to save your EXP and level up in every game mode."}</p>
    </header>
    <form class="auth-form" novalidate>
      <label>Username
        <input name="username" autocomplete="username" maxlength="50" required>
      </label>
      ${isLogin ? "" : `<p class="field-hint">3 to 50 characters: letters, numbers and underscores.</p>`}
      <label>Password
        <input name="password" type="password" autocomplete="${isLogin ? "current-password" : "new-password"}" maxlength="128" required>
      </label>
      ${isLogin ? "" : `<p class="field-hint">At least 8 characters.</p>
      <label>Confirm password
        <input name="confirm" type="password" autocomplete="new-password" maxlength="128" required>
      </label>`}
      <p class="form-error" role="alert" hidden></p>
      <button type="submit" class="btn">${isLogin ? "Log in" : "Create account"}</button>
      <p class="auth-switch">${isLogin
        ? `No account yet? <a href="#/register">Sign up</a>`
        : `Already have an account? <a href="#/login">Log in</a>`}</p>
    </form>`;

  const form = root.querySelector("form");
  const errorEl = form.querySelector(".form-error");
  const submit = form.querySelector("button[type=submit]");
  const label = submit.textContent;
  const showError = (text) => { errorEl.textContent = text; errorEl.hidden = false; };
  form.elements.username.focus();

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errorEl.hidden = true;
    const username = form.elements.username.value.trim();
    const password = form.elements.password.value;
    const problem = isLogin
      ? (!username || !password ? "Enter your username and password." : "")
      : signUpProblem(username, password, form.elements.confirm.value);
    if (problem) { showError(problem); return; }

    submit.disabled = true;
    submit.textContent = isLogin ? "Logging in…" : "Creating account…";
    const res = isLogin ? await logIn(username, password) : await signUp(username, password);
    if (res.ok) {
      const name = getSession() ? getSession().username : username;
      showToast(isLogin ? `Welcome back, ${name}!` : `Account created. Welcome, ${name}!`);
      location.hash = "#/";
      return;
    }
    submit.disabled = false;
    submit.textContent = label;
    showError(res.status === 409
      ? "That username is already taken. Try another one."
      : errorMessage(res.data, "Something went wrong. Please try again."));
  });
}

async function startAccount(root) {
  const session = getSession();
  if (!session) {
    root.innerHTML = `<a class="back" href="#/">Back to games</a>
      <header class="game-head"><h1>My progress</h1>
        <p>Log in to see your EXP and levels for every game mode.</p></header>
      <div class="auth-actions"><a class="btn" href="#/login">Log in</a> <a class="btn-quiet" href="#/register">Sign up</a></div>`;
    return;
  }

  root.innerHTML = `
    <a class="back" href="#/">Back to games</a>
    <header class="game-head">
      <h1>My progress</h1>
      <p>Signed in as <strong>${escapeHtml(session.username)}</strong>. Finished games earn 10 EXP per correct answer,
        up to 100 per game, and every ${EXP_PER_LEVEL} EXP is a new level.</p>
    </header>
    <div id="progress-list"><p class="loading" role="status">Loading your progress…</p></div>
    <section class="danger-zone" aria-labelledby="delete-heading">
      <h2 id="delete-heading">Delete account</h2>
      <p>This permanently deletes your account and all of your EXP. It can't be undone.</p>
      <form class="auth-form" novalidate>
        <label>Type your username to confirm
          <input name="confirmName" autocomplete="off" spellcheck="false">
        </label>
        <p class="form-error" role="alert" hidden></p>
        <button type="submit" class="btn btn-danger">Delete my account</button>
      </form>
    </section>`;

  const form = root.querySelector(".danger-zone form");
  const errorEl = form.querySelector(".form-error");
  const submit = form.querySelector("button[type=submit]");
  const showError = (text) => { errorEl.textContent = text; errorEl.hidden = false; };

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errorEl.hidden = true;
    const current = getSession();
    if (!current) { route(); return; }
    if (form.elements.confirmName.value.trim().toLowerCase() !== current.username.toLowerCase()) {
      showError("That doesn't match your username.");
      return;
    }
    submit.disabled = true;
    submit.textContent = "Deleting…";
    const res = await api("/api/v1/users/me", { method: "DELETE", auth: true });
    if (res.ok) {
      clearSession();
      showToast("Your account has been deleted.");
      location.hash = "#/";
      return;
    }
    submit.disabled = false;
    submit.textContent = "Delete my account";
    showError(errorMessage(res.data, "Couldn't delete your account. Please try again."));
  });

  await refreshProgress();
  if (location.hash !== "#/account") return;   // the player left while it loaded
  if (!getSession()) { route(); return; }      // the session ended while it loaded

  root.querySelector("#progress-list").innerHTML = CATEGORIES.map((cat) => `
    <section class="progress-cat" data-cat="${cat.id}">
      <h2>${cat.name}</h2>
      <ul class="progress-rows">${cat.modes.map((m) => {
        const exp = progressBySlug[m.href.slice(2)] || 0;
        return `<li>
          <a class="progress-name" href="${m.href}">${m.name}</a>
          <span class="progress-level">Lv ${levelFor(exp)}</span>
          ${expBarHtml(exp % EXP_PER_LEVEL)}
          <span class="progress-exp">${exp} EXP</span>
        </li>`;
      }).join("")}</ul>
    </section>`).join("");
}

/* =====================================================
   START
   ===================================================== */
renderAccountBar();
renderCategories();
checkApi();
refreshProgress();
window.addEventListener("hashchange", route);
route();   // open the right screen when the page loads on a #/ address
route();