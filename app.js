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
  if (champion.image_url) return `${API_BASE}${champion.image_url}`;
  if (champion.image) return `${API_BASE}/images/${champion.image}`;
  return null;
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
  "loldle/lore": startLore,
  "quick/higher-lower": startHigherLower,
  "quick/odd-one-out": startOddOneOut,
  "quick/true-false": startTrueFalse,
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
    <div class="result-text"><h2>${headline}</h2><p>${detail}</p></div>
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
          ${portraitHtml(c)}<span>${escapeHtml(c.name)}</span></li>`).join("")
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
        <div class="cell-champ">${portraitHtml(g)}<span>${escapeHtml(g.name)}</span></div>
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
          `<li>${portraitHtml(c)}<span>${escapeHtml(c.name)}</span><span class="wrong-x" aria-hidden="true">✕</span></li>`).join("")}</ul>`
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
  return `${portraitHtml(champ, "lg")}<span class="opt-name">${escapeHtml(champ.name)}</span>`;
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
        ${round.options.map((o, i) => `<button type="button" class="quiz-option" data-i="${i}">${o.html}<span class="quiz-mark" aria-hidden="true"></span></button>`).join("")}
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
      <div class="result-text"><h2>${score} out of ${ROUNDS_PER_GAME}</h2><p>${verdict}</p></div>
      <button type="button" class="btn" id="again">Play again</button>
    </div>`;
    const again = quiz.querySelector("#again");
    again.addEventListener("click", newRun);
    again.focus();
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
    visual: portraitHtml(champ, "lg"),
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
   START
   ===================================================== */
renderCategories();
checkApi();
window.addEventListener("hashchange", route);
route();