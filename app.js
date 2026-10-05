/* =====================================================
   SECTION 1: API LAYER
   ===================================================== */
const API_BASE = "https://cloud-computing-activity.vercel.app";
const API_KEY = "arceo-api-key-123";
const CACHE_KEY = "moba-hub:roster:v1";

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

// image_url comes back as a relative path like "/images/zed.jpg".
function imageUrl(champion) {
  return champion.image_url ? `${API_BASE}${champion.image_url}` : null;
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
      { name: "Lore", desc: "Name the champion from their story.", href: "#/loldle/lore", ready: false },
      { name: "Endless", desc: "Unlimited rounds with a random champion each time.", href: "#/loldle/endless", ready: false },
    ],
  },
  {
    id: "quick",
    name: "Quick decisions",
    blurb: "One question, one click.",
    modes: [
      { name: "Higher or Lower", desc: "Which champion has the higher skill ceiling?", href: "#/quick/higher-lower", ready: false },
      { name: "Odd One Out", desc: "Three champions share something. Find the one that doesn't.", href: "#/quick/odd-one-out", ready: false },
      { name: "True or False", desc: "Judge a statement about a champion.", href: "#/quick/true-false", ready: false },
    ],
  },
  {
    id: "matching",
    name: "Matching",
    blurb: "Put champions where they belong.",
    modes: [
      { name: "Match the Region", desc: "Sort champions into their home regions.", href: "#/matching/region", ready: false },
      { name: "Lore Match", desc: "Pair each story with its champion.", href: "#/matching/lore", ready: false },
      { name: "Role Sort", desc: "Drop each champion into the right role, against the clock.", href: "#/matching/role", ready: false },
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
};

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]
  ));
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
          ? `<li><a class="mode" href="${m.href}"><span class="mode-name">${m.name}</span><span class="mode-desc">${m.desc}</span><span class="mode-state">Play</span></a></li>`
          : `<li><div class="mode is-locked"><span class="mode-name">${m.name}</span><span class="mode-desc">${m.desc}</span><span class="mode-state">Not built yet</span></div></li>`
        ).join("")}
      </ul>
    </section>`).join("");
}

async function checkApi() {
  try {
    const roster = await getRoster();
    statusEl.textContent = `${roster.length} champions loaded`;
    statusEl.dataset.state = "ok";
  } catch (err) {
    statusEl.textContent = "Couldn't reach the API. Check your connection or the API key, then reload.";
    statusEl.dataset.state = "error";
    console.error(err);
  }
}

function route() {
  const key = location.hash.replace(/^#\//, "");
  const start = GAMES[key];
  gameScreen.innerHTML = "";
  if (start) {
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
   SECTION 5: LOLDLE - CLASSIC
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

function portraitHtml(champ, size = "sm") {
  const src = imageUrl(champ);
  return `<span class="portrait portrait-${size}" data-initial="${escapeHtml(champ.name[0])}">${
    src ? `<img src="${escapeHtml(src)}" alt="" loading="lazy">` : ""
  }</span>`;
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
  root.innerHTML = `<p class="loading" role="status">Loading roster…</p>`;

  let roster;
  try {
    roster = await getRoster();
  } catch (err) {
    console.error(err);
    root.innerHTML = `<a class="back" href="#/">Back to games</a>
      <p class="error">Couldn't load the roster. Check the API and reload the page.</p>`;
    return;
  }
  if (location.hash !== "#/loldle/classic") return; // user left while loading

  // ---- state ----
  let secret = pickRandom(roster);
  let guesses = [];          // champion objects, oldest first
  let status = "playing";    // "playing" | "won" | "gaveUp"
  let matches = [];          // current dropdown options
  let active = -1;           // highlighted dropdown option

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
      <div class="combo">
        <label class="sr-only" for="guess-input">Champion name</label>
        <input id="guess-input" type="text" autocomplete="off" spellcheck="false"
          placeholder="Type a champion name"
          role="combobox" aria-expanded="false" aria-controls="guess-list" aria-autocomplete="list">
        <ul id="guess-list" class="options" role="listbox" hidden></ul>
      </div>
      <button type="button" id="give-up" class="btn-quiet">Reveal answer</button>
    </div>
    <p id="counter" class="counter" role="status"></p>
    <div id="result"></div>
    <div class="board-scroll"><div id="board" class="board"></div></div>
  `;

  const input = root.querySelector("#guess-input");
  const list = root.querySelector("#guess-list");
  const board = root.querySelector("#board");
  const result = root.querySelector("#result");
  const counter = root.querySelector("#counter");
  const giveUpBtn = root.querySelector("#give-up");

  // A missing image falls back to the initial letter behind it.
  root.addEventListener("error", (e) => {
    if (e.target.tagName === "IMG") e.target.classList.add("broken");
  }, true);

  // ---- dropdown ----
  function closeList() {
    list.hidden = true;
    matches = [];
    active = -1;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
  }

  function renderList(query) {
    const used = new Set(guesses.map((g) => g.id));
    const q = query.toLowerCase();
    matches = roster
      .filter((c) => !used.has(c.id) && c.name.toLowerCase().includes(q))
      .sort((a, b) => {
        const aStart = a.name.toLowerCase().startsWith(q) ? 0 : 1;
        const bStart = b.name.toLowerCase().startsWith(q) ? 0 : 1;
        return aStart - bStart || a.name.localeCompare(b.name);
      })
      .slice(0, 8);
    active = matches.length ? 0 : -1;

    list.innerHTML = matches.length
      ? matches.map((c, i) => `<li id="opt-${i}" role="option" data-id="${c.id}" aria-selected="${i === active}">
          ${portraitHtml(c)}<span>${escapeHtml(c.name)}</span></li>`).join("")
      : `<li class="no-match">No champion matches "${escapeHtml(query)}"</li>`;
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
    if (active >= 0) input.setAttribute("aria-activedescendant", "opt-0");
  }

  function moveActive(step) {
    if (!matches.length) return;
    active = (active + step + matches.length) % matches.length;
    list.querySelectorAll("[role=option]").forEach((el, i) => {
      el.setAttribute("aria-selected", String(i === active));
    });
    input.setAttribute("aria-activedescendant", `opt-${active}`);
    list.querySelector(`#opt-${active}`).scrollIntoView({ block: "nearest" });
  }

  input.addEventListener("input", () => {
    const q = input.value.trim();
    q ? renderList(q) : closeList();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); moveActive(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); moveActive(-1); }
    else if (e.key === "Enter" && active >= 0) { e.preventDefault(); makeGuess(matches[active]); }
    else if (e.key === "Escape") closeList();
  });
  // mousedown (not click) so it fires before the input loses focus
  list.addEventListener("mousedown", (e) => {
    const li = e.target.closest("[role=option]");
    if (!li) return;
    e.preventDefault();
    makeGuess(roster.find((c) => c.id === Number(li.dataset.id)));
  });
  input.addEventListener("blur", closeList);

  // ---- game flow ----
  function makeGuess(champ) {
    if (status !== "playing" || !champ) return;
    guesses.push(champ);
    if (champ.id === secret.id) status = "won";
    input.value = "";
    closeList();
    render();
    if (status === "playing") input.focus();
  }

  function newGame() {
    const previous = secret;
    do { secret = pickRandom(roster); } while (roster.length > 1 && secret.id === previous.id);
    guesses = [];
    status = "playing";
    render();
    input.focus();
  }

  giveUpBtn.addEventListener("click", () => {
    if (status !== "playing") return;
    status = "gaveUp";
    render();
  });

  // ---- drawing ----
  function renderBoard() {
    if (!guesses.length) {
      board.innerHTML = `<p class="empty">Your guesses will show up here. Pick any champion to start.</p>`;
      return;
    }
    const head = `<div class="row row-head"><div>Champion</div>${
      CLASSIC_COLUMNS.map((c) => `<div>${c.label}</div>`).join("")}</div>`;
    const rows = guesses.slice().reverse().map((g, idx) => `
      <div class="row${idx === 0 ? " fresh" : ""}">
        <div class="cell-champ">${portraitHtml(g)}<span>${escapeHtml(g.name)}</span></div>
        ${CLASSIC_COLUMNS.map((c, i) => renderTile(c, g, secret, i)).join("")}
      </div>`).join("");
    board.innerHTML = head + rows;
  }

  function renderResult() {
    if (status === "playing") { result.innerHTML = ""; return; }
    const n = guesses.length;
    const headline = status === "won"
      ? `You found ${escapeHtml(secret.name)}`
      : `It was ${escapeHtml(secret.name)}`;
    const detail = status === "won"
      ? `${n} ${n === 1 ? "guess" : "guesses"}`
      : escapeHtml(secret.title);
    result.innerHTML = `<div class="result" data-status="${status}">
      ${portraitHtml(secret, "lg")}
      <div class="result-text"><h2>${headline}</h2><p>${detail}</p></div>
      <button type="button" id="again" class="btn">New game</button>
    </div>`;
    result.querySelector("#again").addEventListener("click", newGame);
  }

  function render() {
    const playing = status === "playing";
    input.disabled = !playing;
    giveUpBtn.hidden = !playing;
    counter.textContent = guesses.length
      ? `${guesses.length} ${guesses.length === 1 ? "guess" : "guesses"} so far`
      : "";
    renderBoard();
    renderResult();
  }

  render();
  input.focus();
}

/* =====================================================
   START
   ===================================================== */
renderCategories();
checkApi();
window.addEventListener("hashchange", route);
route();