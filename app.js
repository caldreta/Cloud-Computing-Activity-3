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
      { name: "Classic", desc: "Guess champions and read the attribute tiles.", href: "loldle.html?mode=classic", ready: false },
      { name: "Lore", desc: "Name the champion from their story.", href: "loldle.html?mode=lore", ready: false },
      { name: "Endless", desc: "Unlimited rounds with a random champion each time.", href: "loldle.html?mode=endless", ready: false },
    ],
  },
  {
    id: "quick",
    name: "Quick decisions",
    blurb: "One question, one click.",
    modes: [
      { name: "Higher or Lower", desc: "Which champion has the higher skill ceiling?", href: "quick.html?mode=higher-lower", ready: false },
      { name: "Odd One Out", desc: "Three champions share something. Find the one that doesn't.", href: "quick.html?mode=odd-one-out", ready: false },
      { name: "True or False", desc: "Judge a statement about a champion.", href: "quick.html?mode=true-false", ready: false },
    ],
  },
  {
    id: "matching",
    name: "Matching",
    blurb: "Put champions where they belong.",
    modes: [
      { name: "Match the Region", desc: "Sort champions into their home regions.", href: "matching.html?mode=region", ready: false },
      { name: "Lore Match", desc: "Pair each story with its champion.", href: "matching.html?mode=lore", ready: false },
      { name: "Role Sort", desc: "Drop each champion into the right role, against the clock.", href: "matching.html?mode=role", ready: false },
    ],
  },
];

/* =====================================================
   SECTION 4: HUB (main page)
   ===================================================== */
const main = document.getElementById("categories");
const statusEl = document.getElementById("api-status");

function renderCategories() {
  main.innerHTML = CATEGORIES.map((cat) => `
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

renderCategories();
checkApi();
