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
  favoriteChamp = null;
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
  await refreshRole();
  await refreshProgress();
  await refreshFavorite();
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
  const before = progressBySlug[slug] || 0;
  progressBySlug[slug] = exp;
  renderCategories();
  renderAccountBar();
  const into = exp % EXP_PER_LEVEL;
  const leveledUp = level > levelBefore;
  // the bar starts where the player was, then fills to the new total
  const from = leveledUp ? 0 : before % EXP_PER_LEVEL;
  onUpdate(`<span class="reward-card${leveledUp ? " is-level-up" : ""}">
      <span class="reward-crest" aria-hidden="true"><span>${level}</span></span>
      <span class="reward-body">
        <span class="reward-line"><strong class="reward-gain" data-count="${gained}">+${gained} EXP</strong>
          <span class="reward-level">${leveledUp ? `Level up! You reached level ${level}` : `Level ${level}`}</span></span>
        ${expBarHtml(into, from)}
        <span class="reward-next">${EXP_PER_LEVEL - into} EXP to level ${level + 1}</span>
      </span>
    </span>`);
  animateRewards();
  if (leveledUp) showToast(`Level up! You reached level ${level}.`);
}

/* ---------- Favorite counter ----------
   Every champion a player answers correctly is sent to the API, which counts them in the
   user_character_stats table (users <-> characters). The most-counted one is the favorite counter. */
let favoriteChamp = null;   // { id, name, title, image, times_correct } or null

// Sends the champions answered correctly in one finished game. Guests are skipped.
async function recordHits(characterIds) {
  const ids = [...new Set(characterIds)].filter(Boolean).slice(0, 20);
  if (!getSession() || !ids.length) return;
  const before = favoriteChamp && favoriteChamp.id;
  const res = await api("/api/v1/users/me/characters", { method: "POST", body: { character_ids: ids }, auth: true });
  if (!res.ok) return;   // never interrupt a game over this
  favoriteChamp = res.data.favorite;
  renderHeroNote();
  if (favoriteChamp && before && favoriteChamp.id !== before) {
    showToast(`New favorite counter: ${favoriteChamp.name}!`);
  }
}

async function refreshFavorite() {
  if (!getSession()) { favoriteChamp = null; return; }
  const res = await api("/api/v1/users/me/characters?limit=1", { auth: true });
  favoriteChamp = res.ok ? res.data.favorite : null;
  renderHeroNote();
}

const reduceMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// Fills EXP bars from their start width to their target, and counts the gained EXP up.
function animateRewards() {
  const bars = [...document.querySelectorAll(".exp-bar > span[data-to]")];
  const counters = [...document.querySelectorAll("[data-count]")];
  const finish = () => {
    bars.forEach((el) => { el.style.width = `${el.dataset.to}%`; el.removeAttribute("data-to"); });
    counters.forEach((el) => { el.textContent = `+${el.dataset.count} EXP`; el.removeAttribute("data-count"); });
  };
  if (reduceMotion()) { finish(); return; }
  // two frames so the browser paints the start width before the transition begins
  requestAnimationFrame(() => requestAnimationFrame(() => {
    bars.forEach((el) => { el.style.width = `${el.dataset.to}%`; el.removeAttribute("data-to"); });
  }));
  counters.forEach((el) => {
    const target = Number(el.dataset.count);
    el.removeAttribute("data-count");
    const started = performance.now();
    const tick = (now) => {
      const t = Math.min(1, (now - started) / 700);
      el.textContent = `+${Math.round(target * (1 - Math.pow(1 - t, 3)))} EXP`;
      if (t < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

// `from` (optional) is where the bar starts before animating to `into`.
function expBarHtml(into, from) {
  const animate = from !== undefined && from !== into;
  return `<span class="exp-bar" role="img" aria-label="${into} of ${EXP_PER_LEVEL} EXP towards the next level"><span style="width:${animate ? from : into}%"${animate ? ` data-to="${into}"` : ""}></span></span>`;
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

function totalExp() {
  return Object.values(progressBySlug).reduce((sum, exp) => sum + exp, 0);
}

// Overall level: one level per 100 EXP earned across every mode.
function overallLevel() {
  return levelFor(totalExp());
}

// The account area of the top bar: guest links, or the signed-in player's crest.
function renderAccountBar() {
  const el = document.getElementById("account-bar");
  if (!el) return;
  const session = getSession();
  if (!session) {
    el.innerHTML = `<a class="account-link" href="#/login">Log in</a>
      <a class="btn btn-small" href="#/register">Sign up</a>`;
  } else {
    el.innerHTML = `${isAdmin() ? `<a class="account-link admin-link" href="#/admin">Admin</a>` : ""}
      <a class="player" href="#/account" title="See your progress">
        <span class="crest" aria-hidden="true"><span>${overallLevel()}</span></span>
        <span class="player-text"><span class="player-name">${escapeHtml(session.username)}</span>
          <span class="player-sub">Level ${overallLevel()}, ${totalExp()} EXP</span></span>
      </a>
      <button type="button" class="account-link" data-action="logout">Log out</button>`;
    el.querySelector("[data-action=logout]").addEventListener("click", () => {
      logOut();
      if (location.hash === "#/account" || location.hash === "#/admin") location.hash = "#/";
    });
  }
  renderHeroNote();
}

// The line beside "Play a random game" on the hub.
function renderHeroNote() {
  const el = document.getElementById("hero-note");
  if (!el) return;
  const session = getSession();
  if (session && favoriteChamp) {
    el.innerHTML = `Welcome back, ${escapeHtml(session.username)}. You're level ${overallLevel()} overall.
      <a class="hero-favorite" href="#/champions" title="See your top champions">
        ${portraitHtml(favoriteChamp, "sm")}<span>Favorite counter: <strong>${escapeHtml(favoriteChamp.name)}</strong></span></a>`;
    if (!el.dataset.watched) { watchBrokenImages(el); el.dataset.watched = "1"; }
    return;
  }
  el.innerHTML = session
    ? `Welcome back, ${escapeHtml(session.username)}. You're level ${overallLevel()} overall.`
    : `<a href="#/register">Create an account</a> to save your EXP.`;
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
// Level and EXP bar at the foot of a mode card, shown only when someone is logged in.
function modeProgressHtml(href) {
  if (!getSession()) return "";
  const exp = progressBySlug[href.slice(2)] || 0;
  return `<span class="mode-progress"><span class="mode-level">Level ${levelFor(exp)}</span>${expBarHtml(exp % EXP_PER_LEVEL)}</span>`;
}

function renderCategories() {
  categoriesEl.innerHTML = CATEGORIES.map((cat) => `
    <section class="category" data-cat="${cat.id}" aria-labelledby="h-${cat.id}">
      <div class="category-head">
        <h2 id="h-${cat.id}">${cat.name}</h2>
        <p>${cat.blurb}</p>
      </div>
      <ul class="modes">
        ${cat.modes.map((m) => m.ready
          ? `<li><a class="mode mode-card" href="${m.href}"><span class="mode-name">${m.name}</span><span class="mode-desc">${m.desc}</span>${modeProgressHtml(m.href)}</a></li>`
          : `<li><div class="mode mode-card is-locked"><span class="mode-name">${m.name}</span><span class="mode-desc">${m.desc}</span><span class="mode-desc">Coming soon</span></div></li>`
        ).join("")}
      </ul>
    </section>`).join("");
}

// Portraits under the hub title: a random slice of the roster.
function renderRosterStrip(roster) {
  const el = document.getElementById("roster-strip");
  if (!el) return;
  el.innerHTML = shuffle(roster).slice(0, 14).map((c) => portraitHtml(c, "md")).join("");
  [...el.children].forEach((child, n) => child.style.setProperty("--n", n));
  watchBrokenImages(el);
}

// Report a broken image setup to developers in the console, not to players.
function checkImages(roster) {
  const url = roster.length ? imageUrl(roster[0]) : null;
  if (!url) { console.warn("The roster has no image paths, so portraits show initials."); return; }
  const probe = new Image();
  probe.onerror = () => console.error(`Champion images aren't loading. Expected the first one at ${url}`);
  probe.src = url;
}

async function checkApi() {
  statusEl.hidden = true;
  try {
    const roster = await getRoster();
    renderRosterStrip(roster);
    checkImages(roster);
  } catch (err) {
    console.error(err);
    statusEl.hidden = false;
    statusEl.innerHTML = `<span>The champion roster didn't load, so the games can't start yet. Check your internet connection, then try again.</span>
      <button type="button" class="btn-quiet" data-action="retry">Try again</button>`;
    statusEl.querySelector("[data-action=retry]").addEventListener("click", () => {
      try { sessionStorage.removeItem(CACHE_KEY); } catch { /* ignore */ }
      checkApi();
    });
  }
}

const CATEGORY_NAMES = { loldle: "Loldle", quick: "Quick decisions", matching: "Matching", account: "Account", admin: "Admin", champions: "Account" };

// "All games / Loldle" trail at the top of every game and account page.
function crumbHtml() {
  const name = CATEGORY_NAMES[gameScreen.dataset.cat] || "";
  return `<nav class="crumb" aria-label="Breadcrumb"><a href="#/">All games</a>${
    name ? `<span class="crumb-sep" aria-hidden="true">/</span><span aria-current="page">${name}</span>` : ""}</nav>`;
}

function playRandomGame() {
  const modes = CATEGORIES.flatMap((c) => c.modes.filter((m) => m.ready));
  location.hash = pickRandom(modes).href;
}

// Account pages, routed the same way as games.
const PAGES = {
  login: (root) => startAuth(root, "login"),
  register: (root) => startAuth(root, "register"),
  account: startAccount,
  admin: startAdmin,
  champions: startChampions,
};

function route() {
  const key = location.hash.replace(/^#\//, "");
  const start = GAMES[key] || PAGES[key];
  gameScreen.innerHTML = "";
  if (start) {
    gameScreen.dataset.cat = GAMES[key] ? key.split("/")[0] : (key === "admin" ? "admin" : "account");
    hubScreen.hidden = true;
    gameScreen.hidden = false;
    window.scrollTo(0, 0);
    document.title = `${pageTitle(key)} | Champion Games`;
    start(gameScreen);
  } else {
    hubScreen.hidden = false;
    gameScreen.hidden = true;
    document.title = "Champion Games";
  }
}

function pageTitle(key) {
  const mode = CATEGORIES.flatMap((c) => c.modes).find((m) => m.href === `#/${key}`);
  return mode ? mode.name : { login: "Log in", register: "Sign up", account: "My progress", admin: "Admin", champions: "My champions" }[key] || "Champion Games";
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
    root.innerHTML = `${crumbHtml()}
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
    ${crumbHtml()}
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
      recordHits([round.id]);
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
    ${crumbHtml()}
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
      recordHits([round.id]);
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
    ${crumbHtml()}
    <header class="game-head"><h1>${title}</h1><p>${intro}</p></header>
    <div id="quiz"></div>`;
  watchBrokenImages(root);
  const quiz = root.querySelector("#quiz");

  let rounds = [];
  let index = 0;
  let score = 0;
  let answered = null;       // index of the chosen option, or null
  let results = [];          // true / false per answered question, for the progress track
  let hits = [];             // ids of champions answered correctly, for the favorite counter

  function newRun() {
    const used = new Set();
    rounds = Array.from({ length: ROUNDS_PER_GAME }, () => makeRound(roster, used));
    index = 0;
    score = 0;
    results = [];
    hits = [];
    renderRound();
  }

  // Ten segments: green for right, red for wrong, outlined for the current question.
  function trackHtml() {
    const segments = Array.from({ length: ROUNDS_PER_GAME }, (_, k) => {
      const state = k < results.length ? (results[k] ? "right" : "wrong") : k === index ? "current" : "todo";
      return `<span class="track-seg" data-state="${state}"></span>`;
    }).join("");
    return `<div class="quiz-status">
        <div class="quiz-track" aria-hidden="true">${segments}</div>
        <p class="quiz-count" role="status">Question ${index + 1} of ${ROUNDS_PER_GAME}<span>Score ${score}</span></p>
      </div>`;
  }

  function renderRound() {
    const round = rounds[index];
    answered = null;
    const count = round.options.length;
    quiz.innerHTML = `
      <div id="progress">${trackHtml()}</div>
      ${round.visual ? `<div class="quiz-visual">${round.visual}</div>` : ""}
      <h2 class="quiz-prompt">${round.prompt}</h2>
      <div class="quiz-options" data-layout="${round.layout}">
        ${round.options.map((o, i) => `<button type="button" class="quiz-option" data-i="${i}" style="--i:${i}"><span class="key-hint" aria-hidden="true">${i + 1}</span>${o.html}<span class="quiz-mark" aria-hidden="true"></span></button>`).join("")}
      </div>
      <p class="quiz-keys">Tip: press ${count === 2 ? "1 or 2" : `1 to ${count}`} to answer, then Enter for the next question.</p>
      <div id="feedback" class="quiz-feedback" aria-live="polite"></div>`;
    quiz.querySelectorAll(".quiz-option").forEach((btn) => {
      btn.addEventListener("click", () => answer(Number(btn.dataset.i)));
    });
  }

  // Number keys answer the current question while this quiz is on screen.
  function onKey(e) {
    if (!quiz.isConnected) { document.removeEventListener("keydown", onKey); return; }
    if (e.altKey || e.ctrlKey || e.metaKey || answered !== null || !rounds[index]) return;
    const n = Number(e.key);
    if (Number.isInteger(n) && n >= 1 && n <= rounds[index].options.length) {
      e.preventDefault();
      answer(n - 1);
    }
  }
  document.addEventListener("keydown", onKey);

  function answer(i) {
    if (answered !== null) return;
    answered = i;
    const round = rounds[index];
    const right = round.options[i].correct;
    if (right) {
      score++;
      // True or False names its champion in meta; the other quizzes credit the right option's champion
      const champId = round.meta && round.meta.champId
        ? round.meta.champId
        : (round.options.find((o) => o.correct && o.champ) || {}).champ?.id;
      if (champId) hits.push(champId);
    }
    results.push(right);

    quiz.querySelectorAll(".quiz-option").forEach((btn, k) => {
      const isCorrect = round.options[k].correct;
      btn.setAttribute("aria-disabled", "true");
      btn.dataset.state = isCorrect ? "correct" : k === i ? "wrong" : "dim";
      btn.querySelector(".quiz-mark").textContent = isCorrect ? "✓" : k === i ? "✕" : "";
    });
    quiz.querySelector("#progress").innerHTML = trackHtml();

    const last = index === ROUNDS_PER_GAME - 1;
    const feedback = quiz.querySelector("#feedback");
    feedback.innerHTML = `
      <p class="quiz-verdict" data-good="${right}">${right ? "Correct" : "Not quite"}</p>
      <p class="quiz-explain">${round.explain}</p>
      <button type="button" class="btn" id="next">${last ? "See results" : "Next question"}</button>`;
    const next = feedback.querySelector("#next");
    next.addEventListener("click", () => { last ? renderEnd() : (index++, renderRound()); });
    next.focus({ preventScroll: true });
    // on small screens the explanation sits below the cards, so bring it into view
    feedback.scrollIntoView({ block: "nearest", behavior: reduceMotion() ? "auto" : "smooth" });
  }

  function renderEnd() {
    const verdict = score >= 9 ? "Superb." : score >= 7 ? "Nicely done." : score >= 5 ? "Not bad." : "Room to improve.";
    quiz.innerHTML = `${trackHtml().replace(/Question \d+ of \d+/, "Finished")}<div class="result" data-status="won">
      <div class="result-text"><h2><span class="num">${score}</span> out of <span class="num">${ROUNDS_PER_GAME}</span></h2><p>${verdict}</p>
        <p class="reward" data-reward></p></div>
      <button type="button" class="btn" id="again">Play again</button>
    </div>`;
    const again = quiz.querySelector("#again");
    again.addEventListener("click", newRun);
    again.focus();
    const run = rounds;
    awardExp(hash.slice(2), score, ROUNDS_PER_GAME, (html) => { if (rounds === run) setReward(quiz, html); });
    recordHits(hits);
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
    ${crumbHtml()}
    <header class="game-head"><h1>${title}</h1><p>${intro}</p></header>
    <div id="match"></div>`;
  watchBrokenImages(root);
  const mount = root.querySelector("#match");

  let board, placed, selected, mistakes, message, startedAt, finishedAt;
  let reward = "";          // EXP message for the finished board, kept across re-renders
  let animateIn = true;     // cards slide in on a fresh board only, not on every click
  let lastPlaced = null;    // id of the card just placed, so only it pops
  let missed = new Set();   // cards that had a wrong try; they don't count towards the favorite counter

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
    missed = new Set();
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
        recordHits(board.items.filter((i) => i.champ && !missed.has(i.id)).map((i) => i.champ.id));
      } else focusItem(null);
    } else {
      mistakes++;
      missed.add(item.id);
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
    root.innerHTML = `${crumbHtml()}
      <header class="game-head"><h1>You're signed in</h1>
        <p>You're already logged in as <strong>${escapeHtml(session.username)}</strong>.</p></header>
      <a class="btn" href="#/account">See my progress</a>`;
    return;
  }

  root.innerHTML = `
    ${crumbHtml()}
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
    root.innerHTML = `${crumbHtml()}
      <header class="game-head"><h1>My progress</h1>
        <p>Log in to see your EXP and levels for every game mode.</p></header>
      <div class="auth-actions"><a class="btn" href="#/login">Log in</a> <a class="btn-quiet" href="#/register">Sign up</a></div>`;
    return;
  }

  root.innerHTML = `
    ${crumbHtml()}
    <header class="game-head">
      <h1>My progress</h1>
      <p>Signed in as <strong>${escapeHtml(session.username)}</strong>. Finished games earn 10 EXP per correct answer,
        up to 100 per game, and every ${EXP_PER_LEVEL} EXP is a new level.</p>
    </header>
    <a class="btn-quiet account-champions-link" href="#/champions">See my top champions</a>
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
          <span class="progress-level">Level ${levelFor(exp)}</span>
          ${expBarHtml(exp % EXP_PER_LEVEL)}
          <span class="progress-exp">${exp} EXP</span>
        </li>`;
      }).join("")}</ul>
    </section>`).join("");
}

/* =====================================================
   SECTION 10B: MY CHAMPIONS (#/champions)
   The champions this player got right most often. #1 is their favorite counter.
   ===================================================== */
function timesText(n) {
  return `${n} ${n === 1 ? "time" : "times"}`;
}

async function startChampions(root) {
  if (!getSession()) {
    root.innerHTML = `${crumbHtml()}
      <header class="game-head"><h1>My champions</h1>
        <p>Log in to see the champions you get right most often.</p></header>
      <div class="auth-actions"><a class="btn" href="#/login">Log in</a> <a class="btn-quiet" href="#/register">Sign up</a></div>`;
    return;
  }
  root.innerHTML = `${crumbHtml()}
    <header class="game-head"><h1>My champions</h1>
      <p>Every champion you answer correctly is counted. The one you get right most often is your favorite counter.</p></header>
    <div id="champions-body"><p class="loading" role="status">Loading your champions…</p></div>`;

  const res = await api("/api/v1/users/me/characters?limit=10", { auth: true });
  if (location.hash !== "#/champions") return;
  if (!getSession()) { route(); return; }
  const body = root.querySelector("#champions-body");
  if (!res.ok) {
    body.innerHTML = `<p class="error">${escapeHtml(errorMessage(res.data, "Couldn't load your champions."))}</p>`;
    return;
  }

  const list = res.data.characters;
  favoriteChamp = res.data.favorite;
  renderHeroNote();
  if (!list.length) {
    body.innerHTML = `<div class="empty-champions">
        <p>No champions counted yet. Win a Loldle round or answer a quiz question correctly and they'll show up here.</p>
        <button type="button" class="btn" id="champions-play">Play a random game</button>
      </div>`;
    body.querySelector("#champions-play").addEventListener("click", playRandomGame);
    return;
  }

  const [fav, ...rest] = list;
  body.innerHTML = `
    <section class="favorite-card" aria-labelledby="favorite-heading">
      ${portraitHtml(fav, "xl")}
      <div class="favorite-text">
        <p class="favorite-label" id="favorite-heading">Your favorite counter</p>
        <h2 class="favorite-name">${escapeHtml(fav.name)}</h2>
        <p class="favorite-title">${escapeHtml(fav.title || "")}</p>
        <p class="favorite-count">Guessed right <span class="num">${timesText(fav.times_correct)}</span></p>
      </div>
    </section>
    ${rest.length ? `<h2 class="champions-heading">Your next best</h2>
    <ol class="champion-ranks" start="2">${rest.map((c, i) => `
      <li>
        <span class="rank num" aria-hidden="true">${i + 2}</span>
        ${portraitHtml(c, "md")}
        <span class="rank-text"><span class="rank-name">${escapeHtml(c.name)}</span>
          <span class="rank-title">${escapeHtml(c.title || "")}</span></span>
        <span class="rank-count num">${timesText(c.times_correct)}</span>
      </li>`).join("")}</ol>` : ""}`;
  watchBrokenImages(body);
}

/* =====================================================
   SECTION 11: ADMIN PANEL
   #/admin: create accounts, reset passwords, change roles, deactivate and delete.
   Hiding the Admin link from players is only a convenience. The real protection
   is the API, which answers 403 to every admin request from a non-admin.
   ===================================================== */

function isAdmin() {
  const session = getSession();
  return Boolean(session && session.role === "admin");
}

// Asks the API for the logged-in account's role and keeps it with the session.
// An API without the admin update answers 404, which counts as "not an admin".
async function refreshRole() {
  if (!getSession()) return;
  const res = await api("/api/v1/users/me/role", { auth: true });
  if (!res.ok && res.status !== 404) return;   // offline or server error: keep what we had
  const session = getSession();
  if (!session) return;
  const role = res.ok ? res.data.role : "user";
  if (session.role !== role) {
    saveSession({ ...session, role });
    renderAccountBar();
  }
}

const ROLE_NAMES = { user: "Player", admin: "Admin" };

function modeName(slug) {
  const mode = CATEGORIES.flatMap((c) => c.modes).find((m) => m.href === `#/${slug}`);
  return mode ? mode.name : slug;
}

function adminDeniedHtml(text) {
  return `${crumbHtml()}
    <header class="game-head"><h1>Admin</h1><p>${text}</p></header>
    <a class="btn" href="#/">Back to all games</a>`;
}

async function startAdmin(root) {
  if (!getSession()) {
    root.innerHTML = `${crumbHtml()}
      <header class="game-head"><h1>Admin</h1><p>Log in with an admin account to manage players.</p></header>
      <div class="auth-actions"><a class="btn" href="#/login">Log in</a></div>`;
    return;
  }
  root.innerHTML = `${crumbHtml()}
    <header class="game-head"><h1>Admin</h1><p class="loading" role="status">Checking your access…</p></header>`;
  await refreshRole();
  if (location.hash !== "#/admin") return;   // left while checking
  if (!getSession()) { route(); return; }
  if (!isAdmin()) {
    root.innerHTML = adminDeniedHtml("This page is for admin accounts only.");
    return;
  }

  const me = getSession().username.toLowerCase();
  let users = [];
  let open = null;        // { id, kind: "progress" | "password" | "delete" }
  let requestId = 0;      // ignores slow search results that arrive after newer ones

  root.innerHTML = `
    ${crumbHtml()}
    <header class="game-head">
      <h1>Admin</h1>
      <p>Create accounts, reset passwords and manage who can play. Changes apply straight away.</p>
    </header>

    <section class="admin-create" aria-labelledby="create-heading">
      <h2 id="create-heading">Create an account</h2>
      <form class="admin-create-form" novalidate>
        <label>Username
          <input name="username" autocomplete="off" spellcheck="false" maxlength="50">
        </label>
        <label>Password
          <input name="password" type="password" autocomplete="new-password" maxlength="128">
        </label>
        <label>Role
          <select name="role"><option value="user">Player</option><option value="admin">Admin</option></select>
        </label>
        <button type="submit" class="btn">Create account</button>
      </form>
      <p class="field-hint">Usernames use 3 to 50 letters, numbers and underscores. Passwords need at least 8 characters.</p>
      <p class="form-error" role="alert" hidden></p>
    </section>

    <section class="admin-users" aria-labelledby="users-heading">
      <div class="admin-toolbar">
        <h2 id="users-heading">Accounts</h2>
        <span class="admin-count" role="status"></span>
        <label class="admin-search"><span class="sr-only">Search usernames</span>
          <input type="search" placeholder="Search usernames" maxlength="50" spellcheck="false">
        </label>
      </div>
      <div class="admin-list"><p class="loading" role="status">Loading accounts…</p></div>
    </section>`;

  const createForm = root.querySelector(".admin-create-form");
  const createError = root.querySelector(".admin-create .form-error");
  const createButton = createForm.querySelector("button");
  const searchInput = root.querySelector(".admin-search input");
  const countEl = root.querySelector(".admin-count");
  const listEl = root.querySelector(".admin-list");

  const stillHere = () => location.hash === "#/admin" && root.isConnected;

  // Shared handling for failed admin requests. Returns true if the page was replaced.
  function handleAccessLoss(res) {
    if (res.status === 401) { route(); return true; }   // session ended: api() already logged out
    if (res.status === 403) {
      saveSession({ ...getSession(), role: "user" });
      renderAccountBar();
      root.innerHTML = adminDeniedHtml("Your account no longer has admin access.");
      return true;
    }
    return false;
  }

  async function load() {
    const id = ++requestId;
    const q = searchInput.value.trim();
    const res = await api(`/api/v1/admin/users${q ? `?search=${encodeURIComponent(q)}` : ""}`, { auth: true });
    if (id !== requestId || !stillHere()) return;
    if (!res.ok) {
      if (handleAccessLoss(res)) return;
      listEl.innerHTML = `<p class="error">${escapeHtml(errorMessage(res.data, "Couldn't load the accounts."))}</p>`;
      return;
    }
    users = res.data.users;
    if (open && !users.some((u) => u.id === open.id)) open = null;
    renderList();
  }

  function actionsHtml(user, isSelf) {
    const pressed = (kind) => (open && open.id === user.id && open.kind === kind ? "true" : "false");
    const name = escapeHtml(user.username);
    const buttons = [
      `<button type="button" class="admin-btn" data-action="progress" aria-expanded="${pressed("progress")}" aria-label="Progress for ${name}">Progress</button>`,
      `<button type="button" class="admin-btn" data-action="password" aria-expanded="${pressed("password")}" aria-label="Reset password for ${name}">Reset password</button>`,
    ];
    if (isSelf) return buttons.join("");
    buttons.push(
      `<button type="button" class="admin-btn" data-action="role">${user.role === "admin" ? "Make player" : "Make admin"}</button>`,
      `<button type="button" class="admin-btn" data-action="active">${user.is_active ? "Deactivate" : "Activate"}</button>`,
      `<button type="button" class="admin-btn admin-btn-danger" data-action="delete" aria-expanded="${pressed("delete")}" aria-label="Delete ${name}">Delete</button>`,
    );
    return buttons.join("");
  }

  function panelHtml(user) {
    const name = escapeHtml(user.username);
    if (open.kind === "progress") {
      return `<p class="loading" role="status">Loading ${name}'s progress…</p>`;
    }
    if (open.kind === "password") {
      return `<form class="admin-inline-form" data-form="password" novalidate>
          <label>New password for ${name}
            <input name="newPassword" type="password" autocomplete="new-password" maxlength="128">
          </label>
          <button type="submit" class="btn btn-small">Save password</button>
          <button type="button" class="btn-quiet btn-small" data-action="close">Cancel</button>
          <p class="form-error" role="alert" hidden></p>
        </form>`;
    }
    return `<div class="admin-inline-form admin-confirm">
        <p>Delete <strong>${name}</strong> and all of their EXP? This can't be undone.</p>
        <button type="button" class="btn btn-danger btn-small" data-action="confirm-delete">Delete ${name}</button>
        <button type="button" class="btn-quiet btn-small" data-action="close">Cancel</button>
        <p class="form-error" role="alert" hidden></p>
      </div>`;
  }

  function renderList() {
    countEl.textContent = `${users.length} ${users.length === 1 ? "account" : "accounts"}`;
    if (!users.length) {
      listEl.innerHTML = `<p class="empty">${searchInput.value.trim()
        ? "No usernames match that search."
        : "No accounts yet. Create one above."}</p>`;
      return;
    }
    listEl.innerHTML = `<table class="admin-table">
      <thead><tr>
        <th scope="col">Username</th><th scope="col">Role</th><th scope="col">Status</th>
        <th scope="col">Level</th><th scope="col"><span class="sr-only">Actions</span></th>
      </tr></thead>
      <tbody>${users.map((user) => {
        const isSelf = user.username.toLowerCase() === me;
        const row = `<tr data-id="${user.id}"${user.is_active ? "" : ` class="is-inactive"`}>
          <th scope="row"><span class="admin-name">${escapeHtml(user.username)}</span>${isSelf ? ` <span class="you-tag">You</span>` : ""}</th>
          <td data-label="Role"><span class="role-badge" data-role="${user.role}">${ROLE_NAMES[user.role] || user.role}</span></td>
          <td data-label="Status"><span class="status" data-active="${user.is_active}">${user.is_active ? "Active" : "Deactivated"}</span></td>
          <td data-label="Level"><span class="num">Level ${user.level}</span> <span class="admin-exp num">${user.total_exp} EXP</span></td>
          <td class="admin-actions"><div class="admin-actions-inner">${actionsHtml(user, isSelf)}</div></td>
        </tr>`;
        const panel = open && open.id === user.id
          ? `<tr class="admin-panel-row" data-panel-for="${user.id}"><td colspan="5">${panelHtml(user)}</td></tr>`
          : "";
        return row + panel;
      }).join("")}</tbody>
    </table>`;

    if (!open) return;
    const panel = listEl.querySelector(`[data-panel-for="${open.id}"]`);
    if (open.kind === "progress") loadProgress(open.id, panel);
    if (open.kind === "password") panel.querySelector("input").focus();
    if (open.kind === "delete") panel.querySelector("[data-action=confirm-delete]").focus();
  }

  async function loadProgress(id, panel) {
    const res = await api(`/api/v1/admin/users/${id}`, { auth: true });
    if (!stillHere() || !panel.isConnected) return;
    const cell = panel.querySelector("td");
    if (!res.ok) {
      if (handleAccessLoss(res)) return;
      cell.innerHTML = `<p class="error">${escapeHtml(errorMessage(res.data, "Couldn't load this player's progress."))}</p>`;
      return;
    }
    cell.innerHTML = `<ul class="admin-progress">${res.data.progress.map((p) => `
        <li><span class="admin-mode">${escapeHtml(modeName(p.slug))}</span>
          <span class="num">Level ${p.level}</span>
          <span class="admin-exp num">${p.exp} EXP</span>
          ${expBarHtml(p.exp % EXP_PER_LEVEL)}</li>`).join("")}</ul>`;
  }

  function toggle(id, kind) {
    open = open && open.id === id && open.kind === kind ? null : { id, kind };
    renderList();
    if (!open) listEl.querySelector(`tr[data-id="${id}"] [data-action="${kind}"]`)?.focus();
  }

  // Runs one admin request, then reloads the list. Returns true on success.
  async function run(request, success, errorEl) {
    const res = await api(request.path, { method: request.method, body: request.body, auth: true });
    if (!stillHere()) return false;
    if (!res.ok) {
      if (handleAccessLoss(res)) return false;
      const text = errorMessage(res.data, "That didn't work. Please try again.");
      if (errorEl) { errorEl.textContent = text; errorEl.hidden = false; } else showToast(text);
      return false;
    }
    showToast(success);
    return true;
  }

  listEl.addEventListener("click", async (e) => {
    const button = e.target.closest("button[data-action]");
    if (!button) return;
    const id = Number(button.closest("tr").dataset.id || button.closest("tr").dataset.panelFor);
    const user = users.find((u) => u.id === id);
    if (!user) return;
    const action = button.dataset.action;

    if (action === "progress" || action === "password" || action === "delete") { toggle(id, action); return; }
    if (action === "close") { toggle(id, open.kind); return; }

    button.disabled = true;
    let ok = false;
    if (action === "role") {
      const role = user.role === "admin" ? "user" : "admin";
      ok = await run({ path: `/api/v1/admin/users/${id}`, method: "PATCH", body: { role } },
        role === "admin" ? `${user.username} is now an admin.` : `${user.username} is now a player.`);
    } else if (action === "active") {
      const isActive = !user.is_active;
      ok = await run({ path: `/api/v1/admin/users/${id}`, method: "PATCH", body: { is_active: isActive } },
        isActive ? `Activated ${user.username}.` : `Deactivated ${user.username}. They can't log in until you activate them.`);
    } else if (action === "confirm-delete") {
      const errorEl = button.parentElement.querySelector(".form-error");
      ok = await run({ path: `/api/v1/admin/users/${id}`, method: "DELETE" }, `Deleted ${user.username}.`, errorEl);
      if (ok) open = null;
    }
    if (!stillHere()) return;
    button.disabled = false;
    if (ok) await load();
  });

  listEl.addEventListener("submit", async (e) => {
    const form = e.target.closest("[data-form=password]");
    if (!form) return;
    e.preventDefault();
    const id = Number(form.closest("tr").dataset.panelFor);
    const user = users.find((u) => u.id === id);
    const errorEl = form.querySelector(".form-error");
    const password = form.elements.newPassword.value;
    errorEl.hidden = true;
    if (password.length < 8 || password.length > 128) {
      errorEl.textContent = "The new password must be 8 to 128 characters.";
      errorEl.hidden = false;
      return;
    }
    const submit = form.querySelector("button[type=submit]");
    submit.disabled = true;
    submit.textContent = "Saving…";
    const ok = await run(
      { path: `/api/v1/admin/users/${id}/password`, method: "PATCH", body: { new_password: password } },
      `Saved a new password for ${user.username}.`, errorEl);
    if (!stillHere()) return;
    if (ok) { open = null; renderList(); return; }
    submit.disabled = false;
    submit.textContent = "Save password";
  });

  createForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    createError.hidden = true;
    const username = createForm.elements.username.value.trim();
    const password = createForm.elements.password.value;
    const role = createForm.elements.role.value;
    const problem = signUpProblem(username, password, password);
    if (problem) {
      createError.textContent = problem.replace("Your username", "The username").replace("Your password", "The password");
      createError.hidden = false;
      return;
    }
    createButton.disabled = true;
    createButton.textContent = "Creating…";
    const ok = await run({ path: "/api/v1/admin/users", method: "POST", body: { username, password, role } },
      `Created ${username} as ${role === "admin" ? "an admin" : "a player"}.`, createError);
    if (!stillHere()) return;
    createButton.disabled = false;
    createButton.textContent = "Create account";
    if (ok) {
      createForm.reset();
      await load();
    }
  });

  let searchTimer;
  searchInput.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(load, 250);
  });

  await load();
}

/* =====================================================
   START
   ===================================================== */
document.getElementById("random-game").addEventListener("click", playRandomGame);
renderAccountBar();
renderCategories();
checkApi();
refreshProgress();
refreshFavorite();
refreshRole();   // the role can change while the player is away, so check it on every visit
window.addEventListener("hashchange", route);
route();   // open the right screen when the page loads on a #/ address
