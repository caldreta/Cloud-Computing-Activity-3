# How Champion Games uses the API

This document covers every point where the project touches the champion API: what it calls, what it sends, what it reads back, and what it does not use.

## 1. The short version

- The project makes **one API request per browser session**: `GET /api/v1/characters`.
- That single response (all 40 champions) is kept in memory and reused by every game.
- The API supplies **all game data**. Nothing about specific champions is written into the project's code.
- The API does **not** supply the images. They are loaded from a local `images/` folder (see section 6).

## 2. Connection settings

These are the three constants at the top of `app.js`, in "Section 1: API layer".

| Constant | Value | Purpose |
|---|---|---|
| `API_BASE` | `https://cloud-computing-activity.vercel.app` | Where the API lives. |
| `API_KEY` | the key from the API's `index.py` | Sent with every request. |
| `CACHE_KEY` | `moba-hub:roster:v1` | Name under which the response is cached in the browser. |

To point the project at a different deployment or key, change `API_BASE` and `API_KEY` there. Nothing else needs to change.

## 3. The request

```
GET https://cloud-computing-activity.vercel.app/api/v1/characters
Header:  x-api-key: <API_KEY>
```

The call is made by one function, `getRoster()`. Every game goes through it, and no game calls `fetch()` itself.

### What the API checks

The API's `verify_api_key` function compares the `x-api-key` header with its stored key. If it is missing or wrong, the API answers `401` with `"Invalid or missing API key."`.

### Cross-origin access

The project runs on a different address from the API, so the browser applies cross-origin rules. The API allows this: it uses CORS with every origin, method, and header allowed, so the custom `x-api-key` header works from any site.

## 4. The response, and what the project reads from it

The API returns:

```json
{
  "count": 40,
  "characters": [ { "...one object per champion..." } ]
}
```

`getRoster()` keeps only the `characters` array. Each champion has 34 fields. The project reads these:

| Field | Example | Used by |
|---|---|---|
| `id` | `2` | Telling champions apart (guess tracking, matching). |
| `name` | `"Zed"` | Everywhere a champion is shown, the search box, and name hiding in lore. |
| `title` | `"The Master of Shadows"` | Lore (last clue) and the "It was..." panel. |
| `lore` | a paragraph of story | Lore and Lore Match. |
| `image` | `"zed.jpg"` | The image filename (see section 6). |
| `image_url` | `"/images/zed.jpg"` | Added by the API. Used only as a fallback to find the filename. |
| `role` | `"Assassin"` (or `"Fighter / Assassin"`) | Classic, Odd One Out, True or False, Role Sort. |
| `region` | `"Ionia"` (or `"Piltover / Zaun"`) | Classic, Odd One Out, True or False, Match the Region. |
| `playstyle` | `"Ambush"` | Classic, Odd One Out, True or False. |
| `damage_type` | `"AD"` | Classic, Odd One Out, True or False. |
| `attack_type` | `"Melee"` | Classic, Odd One Out, True or False. |
| `mobility` | `"High"` | Classic, Odd One Out, True or False. |
| `difficulty` | `"Hard"` | Classic, Odd One Out, True or False. |
| `skill_floor` | `4` | Higher or Lower. |
| `skill_ceiling` | `5` | Classic, Higher or Lower. |
| `year_released` | `2012` | Classic, Higher or Lower, True or False. |

The other 18 fields (for example `faction`, `origin`, `weapon`, `personality`, `allies`, `enemies`) are fetched but not used yet. They are available if you want to add games or clues.

### Data conventions the project relies on

- **Multi-value fields.** `role` and `region` can hold several values separated by ` / `. The project splits them with `splitMulti()`.
- **Ordered text values.** `mobility` is `Low`, `Medium` or `High`, and `difficulty` is `Easy`, `Medium` or `Hard`. Classic ranks them in that order to show higher/lower arrows. A different spelling in the data would break the arrows, so keep these values consistent.
- **Numbers are numbers.** `skill_floor`, `skill_ceiling` and `year_released` are numeric. They are compared as numbers.
- **Small naming differences are handled.** A leading "The" is ignored when comparing regions, so "The Void" and "Void" match.

## 5. Caching and when requests happen

1. When the home page loads, `checkApi()` calls `getRoster()`. This is the one real network request.
2. The response is stored in the browser's `sessionStorage` under `moba-hub:roster:v1`.
3. Every game calls `getRoster()` again, and it returns the stored copy instantly.

Because it is `sessionStorage`:

- It lasts for the browser tab's session and is cleared when the tab is closed.
- A page refresh keeps it. **If you change the API's data, close the tab or clear the site's storage to see the change.**
- If you change the data's shape, change `v1` in `CACHE_KEY` to `v2` so old cached copies are ignored.

## 6. Images

The API returns an `image` filename and an `image_url` path like `/images/zed.jpg`. But the API **does not serve those files**: its code has no route or static folder for `/images`. Opening `https://cloud-computing-activity.vercel.app/images/zed.jpg` therefore fails.

So for now the project loads images from a folder next to `index.html`:

```js
const IMAGE_BASE = "images/";
function imageUrl(champion) { /* returns IMAGE_BASE + the filename */ }
```

`imageUrl()` takes the filename from `image` (or from the end of `image_url` if `image` is missing). If there is no image data at all, the champion shows a letter tile instead.

**To serve images from the API later**, put the files in a `public/images/` folder in the API project and redeploy. Vercel then serves them at `/images/zed.jpg`. After that, change one line in `app.js`:

```js
const IMAGE_BASE = `${API_BASE}/images/`;
```

The home page runs an image check on load: it tries to load the first champion's picture and shows "Images are loading" or the path it expected.

## 7. Error handling

| Situation | What happens |
|---|---|
| The API is unreachable, or the key is wrong | The home page badge shows "Couldn't reach the API...". Opening a game shows "Couldn't load the roster" with a back link. Details are logged to the browser console. |
| One image is missing | That champion shows a letter tile. Everything else is unaffected. |
| No images load at all | The image badge shows the exact path it tried. |
| A champion has no `lore` or `title` | The project handles it: a missing lore gives fewer clues, and a missing title is skipped. |

## 8. API endpoints the project does not use

The API has more endpoints than the project needs.

| Endpoint | Why it is not used |
|---|---|
| `GET /api/v1/characters/search?q=...` | The champion search box filters the already-loaded list in the browser. That is instant, works as you type, and costs no requests. |
| `GET /api/v1/characters/{id}` | Every game needs the whole roster anyway, so there is nothing to fetch one at a time. |
| `GET /health` | Not needed. The roster request itself shows whether the API is working. |
| `GET /` | Returns a welcome message only. |

## 9. Security note

The API key is written in `app.js`, so anyone who opens the page can read it in their browser's developer tools, and the API itself allows requests from any origin. That is acceptable for a class project with non-sensitive data. For a real product, keep the key on a server, or make the roster endpoint public and read-only.

## 10. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| "Couldn't reach the API" | No internet, the API is down, or the key does not match the API's. | Check the API's URL in a browser, and compare `API_KEY` in `app.js` with the one in the API's `index.py`. |
| Data changed in the API but the games show old data | The old response is still cached in this tab. | Close the tab and reopen, or clear site data. |
| Portraits show letters instead of pictures | The files are not in `images/`, or the filenames differ from the data. | Check the path shown in the image badge, and match the filenames exactly (watch for `jihn.jpg`). |
| Classic arrows or Odd One Out behave oddly for a new champion | A value is spelled differently from the others (for example `"Med"` instead of `"Medium"`). | Use the same spelling as the existing champions. |
| A new champion's name appears in its own lore | The lore uses another name for them. | Add it to `LORE_ALIASES` in `app.js`. |
