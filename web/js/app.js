// Morning Glory — buildless SPA. Hash router + views. JS owns UI + storage;
// the Python engine (via bridge) owns the recommendation math; sync.js mirrors
// the local store to Firestore for multi-user sharing (optional / offline-first).
import * as db from "./db.js";
import { initEngine, recommend } from "./bridge.js";
import * as sync from "./sync.js";

const METHODS = ["espresso", "moka", "aeropress", "v60", "chemex", "frenchpress", "coldbrew"];
const METHOD_LABEL = {
  espresso: "Espresso", moka: "Moka", aeropress: "AeroPress", v60: "V60",
  chemex: "Chemex", frenchpress: "French press", coldbrew: "Cold brew",
};
// compact forms for tables, where column width is tight
const METHOD_SHORT = {
  espresso: "Espresso", moka: "Moka", aeropress: "AeroPress", v60: "V60",
  chemex: "Chemex", frenchpress: "French", coldbrew: "Cold",
};
// Bump this with every deploy — shown in Settings so you can confirm which
// build the browser/service worker is actually running.
export const APP_VERSION = "1.7.3";

const view = document.getElementById("view");
const boot = document.getElementById("boot");
const bootStatus = document.getElementById("boot-status");

// Home filters. Module-level rather than persisted: they're transient view
// preferences, and they survive re-renders (including ones caused by incoming
// sync) because this module isn't reloaded between navigations.
// Empty array = no constraint on that facet (NOT "match nothing").
let starredOnly = false;
const FILTERS = { roast: [], process: [], roaster: [], decaf: false };

const filterCount = () =>
  FILTERS.roast.length + FILTERS.process.length + FILTERS.roaster.length
  + (FILTERS.decaf ? 1 : 0) + (starredOnly ? 1 : 0);

function clearFilters() {
  FILTERS.roast = []; FILTERS.process = []; FILTERS.roaster = [];
  FILTERS.decaf = false; starredOnly = false;
}

// AND across facets, OR within one — the way people read a filter panel:
// "light OR medium roast, AND washed process".
function applyFilters(list) {
  return list.filter((c) =>
    (!starredOnly || isStarred(c.id))
    && (!FILTERS.decaf || c.decaf)
    && (!FILTERS.roast.length || FILTERS.roast.includes(c.roast))
    && (!FILTERS.process.length || FILTERS.process.includes(c.process))
    && (!FILTERS.roaster.length || FILTERS.roaster.includes(c.roaster || "")));
}

// --- manual card order ------------------------------------------------------
// Deliberately localStorage, NOT the synced record: this is a per-device view
// preference. Syncing it would mean two people silently reshuffling each
// other's list, and it would need a conflict rule for a purely cosmetic value.
const ORDER_KEY = "mg.coffeeOrder";

// Favourites are per person, not per household — same reasoning as the manual
// order. They used to be a `starred` field on the shared coffee record, so one
// of you starring a bag starred it on the other's phone too.
const STAR_KEY = "mg.starred";
let starredIds = null;

function loadStars(all) {
  if (starredIds) return starredIds;   // already loaded this session
  let raw = null;
  try { raw = localStorage.getItem(STAR_KEY); } catch {}
  if (raw == null) {
    // First run since favourites went local: seed from whatever was already
    // starred on the shared records, so nobody loses their picks. Read only —
    // the old field is left alone rather than migrated away.
    starredIds = new Set((all || []).filter((c) => c.starred).map((c) => c.id));
    // Only commit a non-empty seed. On a fresh install the coffees haven't
    // synced down yet, and writing an empty set now would permanently claim
    // "seeded" before there was anything to seed from.
    if (starredIds.size) saveStars(); else starredIds = null;
  } else {
    try {
      const arr = JSON.parse(raw);
      starredIds = new Set(Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : []);
    } catch { starredIds = new Set(); }
  }
  return starredIds;
}
function saveStars() {
  try { localStorage.setItem(STAR_KEY, JSON.stringify([...starredIds])); } catch (e) {
    console.warn("[stars]", e);
  }
}
const isStarred = (id) => !!starredIds && starredIds.has(id);
function toggleStar(id) {
  if (!starredIds) starredIds = new Set();
  if (starredIds.has(id)) starredIds.delete(id); else starredIds.add(id);
  saveStars();
  return starredIds.has(id);
}

function loadOrder() {
  try {
    const raw = JSON.parse(localStorage.getItem(ORDER_KEY) || "[]");
    return Array.isArray(raw) ? raw.filter((x) => typeof x === "string") : [];
  } catch { return []; }
}
function saveOrder(ids) {
  try { localStorage.setItem(ORDER_KEY, JSON.stringify(ids)); }
  catch (e) { console.warn("[order]", e); }
}
// Ids not in the saved order (a coffee added since, or one synced from the
// other person's phone) keep their natural position at the end rather than
// jumping to the top.
function sortByOrder(list) {
  const order = loadOrder();
  const rank = new Map(order.map((id, i) => [id, i]));
  return [...list].sort((a, b) => {
    const ra = rank.has(a.id) ? rank.get(a.id) : Infinity;
    const rb = rank.has(b.id) ? rank.get(b.id) : Infinity;
    return ra === rb ? 0 : ra - rb;
  });
}

// Icons are inline SVG, not text glyphs. ★ and › sit at different heights
// inside their own font boxes, so no amount of flex centring could line them
// up; an SVG's geometry is exact, so equal-sized boxes align perfectly.
const starSvg = (filled) => `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">
  <path d="M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"
        fill="${filled ? "currentColor" : "none"}"
        stroke="currentColor" stroke-width="1.7"
        stroke-linejoin="round"/></svg>`;

const filterSvg = `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">
  <path d="M3 5h18l-7 8v6l-4 2v-8z" fill="none" stroke="currentColor"
        stroke-width="1.8" stroke-linejoin="round"/></svg>`;

const chevSvg = `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">
  <path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2"
        stroke-linecap="round" stroke-linejoin="round"/></svg>`;

const el = (html) => { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstElementChild; };
// Escapes single quotes and backticks too. Every attribute in this file is
// double-quoted, so `"` alone was technically enough — but one future
// single-quoted attribute would have turned that into an injection point.
const esc = (s) => String(s ?? "").replace(/[&<>"'`=]/g, (c) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;",
  "'": "&#39;", "`": "&#96;", "=": "&#61;",
}[c]));

// A photo is only ever a base64 JPEG/PNG data URL produced by resizeImage().
// Anything else — a tampered backup file, a hostile value synced from another
// account — must never reach an <img src>, where `" onerror="…` would execute.
const SAFE_IMAGE = /^data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=]+$/;
const safePhoto = (p) => (typeof p === "string" && SAFE_IMAGE.test(p) ? p : null);

// --- boot -------------------------------------------------------------------
function showApp() {
  boot.hidden = true;
  document.querySelector(".app-header").hidden = false;
  view.hidden = false;
  document.querySelector(".bottom-nav").hidden = false;
}

async function main() {

  // Reveal the UI immediately. Coffee registration / setup work without the
  // engine; only the recommendation number needs Pyodide. Don't block on it.
  // Every navigation goes through safeRoute, not route: previously only the
  // FIRST render was wrapped, so a later failure left a blank screen with the
  // error only in a console you can't open on a phone.
  window.addEventListener("hashchange", safeRoute);
  showApp();
  await safeRoute();

  // Warm the engine in the background. The badges only exist while Settings is
  // on screen, so progress is kept in module state and painted on demand
  // instead of written straight to a node that may not be there.
  initEngine((st) => setEngineState(st.toLowerCase(), false))
    .then(() => setEngineState("ready", true))
    .catch((e) => { console.error("[engine]", e); setEngineState("offline", false); });

  // Start sync in the background (no-op if Firebase isn't configured).
  // When remote data merges in, re-render the current screen.
  sync.initSync({
    onChange: (st) => {
      syncState = st;
      paintBadges();
      // If the Sharing panel is on screen, re-render it so sign-in / household
      // state appears immediately instead of after a manual navigation.
      if (document.getElementById("sync-panel")) renderSyncPanel();
    },
    // A sync arriving mid-drag would re-render the list out from under the
    // finger. Nothing is lost by waiting — the next navigation renders it.
    onData: () => { if (!document.querySelector(".coffee-card.dragging")) safeRoute(); },
  }).catch((e) => console.warn("[sync]", e));
}

// Status badges live on the Settings screen, next to its title — not in the
// app header, where they were on screen at all times for information you only
// look at when something is wrong. Both are painted from module state so they
// come back correct every time Settings is rendered.
let engineState = "loading", engineOk = false, syncState = null;

function setEngineState(text, ok) {
  engineState = text; engineOk = ok;
  paintBadges();
}

function paintBadges() {
  const e = document.getElementById("engine-badge");
  if (e) {
    e.textContent = "engine: " + engineState;
    e.className = "badge" + (engineOk ? " ok" : "");
  }

  const b = document.getElementById("sync-badge");
  if (!b) return;
  const st = syncState;
  if (!st || !st.available) { b.hidden = true; return; }
  b.hidden = false;
  if (!st.signedIn) { b.textContent = "sync: sign in"; b.className = "badge"; }
  else if (!st.householdId) { b.textContent = "sync: no household"; b.className = "badge"; }
  else { b.textContent = st.online ? "sync: on" : "sync: offline";
         b.className = "badge" + (st.online ? " ok" : ""); }
}

// --- router -----------------------------------------------------------------
async function safeRoute() {
  try {
    await route();
  } catch (e) {
    console.error("[route]", e);
    view.replaceChildren(el(`
      <article>
        <strong>Something went wrong on this screen.</strong>
        <p><small>${esc(e.message || e)}</small></p>
        <button id="err-home">Back to your coffees</button>
      </article>`));
    const b = view.querySelector("#err-home");
    if (b) b.addEventListener("click", () => { location.hash = "#/"; });
  }
}

async function route() {
  const hash = location.hash || "#/";
  const [path, query] = hash.slice(1).split("?");
  const params = new URLSearchParams(query || "");
  const parts = path.split("/").filter(Boolean);

  document.querySelectorAll("[data-nav]").forEach((a) =>
    a.classList.toggle("active", a.getAttribute("href") === `#/${parts[0] || ""}`));

  removeFab();   // only Home re-adds it

  // gate on setup
  const grinder = await db.getGrinder();
  if (!grinder && parts[0] !== "setup") { location.hash = "#/setup"; return; }

  if (parts[0] === "setup") return renderSetup();
  if (parts[0] === "coffee" && parts[1] === "new") return renderCoffeeForm();
  if (parts[0] === "coffee" && parts[1] && parts[2] === "edit") return renderCoffeeForm(parts[1]);
  if (parts[0] === "coffee" && parts[1]) return renderCoffee(parts[1]);
  if (parts[0] === "brew") return renderBrew(params.get("coffee"), params.get("method"));
  if (parts[0] === "history") return renderHistory();
  if (parts[0] === "settings") return renderSettings();
  return renderHome();
}

// --- setup ------------------------------------------------------------------
async function renderSetup() {
  const g = (await db.getGrinder()) || { name: "", min: 0, max: 40, step: 0.5, calibration: null };
  const cal = g.calibration || {};
  const methodOpts = METHODS.map((m) =>
    `<option value="${m}" ${cal.method === m ? "selected" : ""}>${METHOD_LABEL[m]}</option>`).join("");
  view.replaceChildren(el(`
    <article>
      <h2>Grinder setup</h2>
      <p><small>Enter your grinder's dial range. The calibration point is optional but recommended: one grind setting that has worked for you on any brew method. It tells the app how your specific dial maps to grind size, so day-one numbers land in the right ballpark. It's ignored once you've logged real brews.</small></p>
      <form id="setup-form">
        <label>Grinder name <input name="name" value="${esc(g.name)}" placeholder="e.g. Baratza Encore" required></label>
        <div class="grid">
          <label>Min <input name="min" type="number" step="any" value="${g.min}" required></label>
          <label>Max <input name="max" type="number" step="any" value="${g.max}" required></label>
          <label>Step <input name="step" type="number" step="any" value="${g.step}" required></label>
        </div>
        <fieldset>
          <legend><small>Calibration point (optional)</small></legend>
          <div class="grid">
            <label>Method <select name="calMethod"><option value="">— none —</option>${methodOpts}</select></label>
            <label>Setting that worked <input name="calSetting" type="number" step="any" value="${cal.setting ?? ""}" placeholder="e.g. 22"></label>
          </div>
        </fieldset>
        <button type="submit">Save</button>
      </form>
    </article>`));
  view.querySelector("#setup-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const cm = f.get("calMethod");
    const cs = f.get("calSetting");
    const calibration = (cm && cs !== "") ? { method: cm, setting: +cs } : null;
    await db.saveGrinder({
      name: f.get("name"), min: +f.get("min"), max: +f.get("max"), step: +f.get("step"),
      calibration,
    });
    location.hash = "#/";
  });
}

// --- home -------------------------------------------------------------------
async function renderHome() {
  const all = sortByOrder(await db.allCoffees());
  loadStars(all);
  const coffees = applyFilters(all);

  const cards = coffees.map((c) => `
        <article class="coffee-card" data-id="${c.id}">
          ${safePhoto(c.photo) ? `<img class="card-thumb" src="${safePhoto(c.photo)}" alt="">` : ""}
          <div class="card-body">
            <div class="card-title">
              <strong>${esc(c.name)}</strong>${c.visibility === "private"
                ? ' <span class="priv-tag">private</span>' : ""}
              ${c.roaster ? `<small class="roaster">${esc(c.roaster)}</small>` : ""}
            </div>
            <small>${c.roast} · ${c.process}${c.origin ? " · " + esc(c.origin) : ""}</small>
          </div>
          ${isStarred(c.id) ? `<span class="star-mark">${starSvg(true)}</span>` : ""}
          <span class="chev">${chevSvg}</span>
        </article>`).join("");

  const list = all.length === 0
    ? `<article class="empty">
         <p><strong>No coffees yet.</strong></p>
         <p><small>Add a bag to get your first grind recommendation.</small></p>
         <button id="add-first">Add your first coffee</button>
       </article>`
    : (coffees.length ? cards
       : `<p class="no-match"><small>No coffees match those filters.</small><br>
          <button type="button" id="clear-filters" class="link-btn">Clear filters</button></p>`);

  view.replaceChildren(el(`
    <div>
      <div class="title-row">
        <h2>Your coffees</h2>
      </div>
      ${list}
    </div>`));

  const clr = view.querySelector("#clear-filters");
  if (clr) clr.addEventListener("click", () => { clearFilters(); safeRoute(); });
  const first = view.querySelector("#add-first");
  if (first) first.addEventListener("click", () => (location.hash = "#/coffee/new"));
  view.querySelectorAll(".coffee-card").forEach((c) =>
    c.addEventListener("click", () => {
      if (justDragged) return;            // the drag's own click, not a tap
      location.hash = `#/coffee/${c.dataset.id}`;
    }));
  enableReorder(view.querySelector(".coffee-card")?.parentElement, all.length);
  addFab("#/coffee/new", "+");
  if (all.length) addFilterFab(all);
}

// --- coffee form ------------------------------------------------------------
// Doubles as the edit screen: pass a coffee id and every field is prefilled and
// the submit updates in place instead of creating. Visibility is deliberately
// NOT editable here — it must go through setCoffeeVisibility on the coffee page,
// which moves the record between the household and the owner's private store.
async function renderCoffeeForm(editId) {
  const ex = editId ? await db.getCoffee(editId) : null;
  if (editId && !ex) { location.hash = "#/"; return; }
  let photoData = ex ? (safePhoto(ex.photo) || null) : null;
  const val = (k) => esc(ex && ex[k] != null ? ex[k] : "");
  const sel = (k, v) => (ex ? (ex[k] === v ? " selected" : "") : "");

  view.replaceChildren(el(`
    <article>
      <div class="title-row">
        <h2>${ex ? "Edit coffee" : "Register coffee"}</h2>
        <button type="button" id="photo-btn" class="icon-btn" title="Add a photo of the bag">📷</button>
      </div>
      <input type="file" id="photo-input" accept="image/*" hidden>
      <div id="photo-preview" class="photo-preview" hidden>
        <img id="photo-img" alt="Coffee bag">
        <button type="button" id="photo-remove" class="link-btn">Remove photo</button>
      </div>

      <form id="coffee-form">
        <label>Name <input name="name" required placeholder="e.g. Songbird" value="${val("name")}"></label>
        <label>Roaster <input name="roaster" placeholder="e.g. Kin" value="${val("roaster")}"></label>
        <div class="grid">
          <label>Roast
            <select name="roast"><option${sel("roast","light")}>light</option><option${ex ? sel("roast","medium") : " selected"}>medium</option><option${sel("roast","dark")}>dark</option></select>
          </label>
          <label>Process
            <select name="process"><option${ex ? sel("process","washed") : " selected"}>washed</option><option${sel("process","honey")}>honey</option><option${sel("process","natural")}>natural</option></select>
          </label>
        </div>
        <details>
          <summary>More detail (optional)</summary>
          <label>Roast date <input name="roastDate" type="date" class="full-width" value="${val("roastDate")}"></label>
          <label>Origin <input name="origin" value="${val("origin")}"></label>
          <label>Variety <input name="variety" value="${val("variety")}"></label>
          <label>Altitude (masl) <input name="altitudeMasl" type="number" inputmode="numeric" value="${val("altitudeMasl")}"></label>

          <div class="toggle-row">
            <button type="button" id="decaf-pill" class="toggle-pill" aria-pressed="${ex && ex.decaf ? "true" : "false"}">Decaf</button>
            ${ex ? "" : `<button type="button" id="private-pill" class="toggle-pill" aria-pressed="false">Private</button>`}
          </div>
          ${ex ? "" : `<p class="explain" style="text-align:center">Private coffees stay on your
          devices only — they aren't shared and don't train anyone else's recommendations.</p>`}

          <label>Notes <textarea name="notes" rows="3">${val("notes")}</textarea></label>
        </details>
        <button type="submit">${ex ? "Save changes" : "Save coffee"}</button>
      </form>
    </article>`));

  // --- photo -------------------------------------------------------------
  const input = view.querySelector("#photo-input");
  const preview = view.querySelector("#photo-preview");
  const img = view.querySelector("#photo-img");
  if (photoData) { img.src = photoData; preview.hidden = false; }
  view.querySelector("#photo-btn").addEventListener("click", () => input.click());
  view.querySelector("#photo-remove").addEventListener("click", () => {
    photoData = null; input.value = ""; preview.hidden = true;
  });
  input.addEventListener("change", async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    try {
      photoData = await resizeImage(file, 700, 0.65);
      img.src = photoData;
      preview.hidden = false;
    } catch (err) {
      console.error("[photo]", err);
      toast("Couldn't read that image");
    }
  });

  // --- toggle pills (decaf, private) --------------------------------------
  const togglePill = (id) => {
    const pill = view.querySelector(id);
    pill.addEventListener("click", () => {
      const on = pill.getAttribute("aria-pressed") === "true";
      pill.setAttribute("aria-pressed", String(!on));
    });
    return pill;
  };
  const decafPill = togglePill("#decaf-pill");
  const privatePill = ex ? null : togglePill("#private-pill");

  view.querySelector("#coffee-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const fields = {
      name: f.get("name"), roaster: f.get("roaster") || null,
      roast: f.get("roast"), process: f.get("process"),
      roastDate: f.get("roastDate") || null, origin: f.get("origin") || null,
      variety: f.get("variety") || null,
      altitudeMasl: f.get("altitudeMasl") ? +f.get("altitudeMasl") : null,
      decaf: decafPill.getAttribute("aria-pressed") === "true" ? 1 : 0,
      notes: f.get("notes") || null,
      photo: photoData,
    };
    let c;
    if (ex) {
      c = await db.updateCoffee({ ...ex, ...fields });
      toast("Saved");
    } else {
      c = await db.addCoffee({
        ...fields,
        visibility: privatePill.getAttribute("aria-pressed") === "true" ? "private" : "shared",
      });
    }
    location.hash = `#/coffee/${c.id}`;
  });
}

// Downscale + JPEG-compress a chosen image so it stays small enough for
// IndexedDB and for a Firestore document (well under the 1 MB doc limit).
// A Firestore document is capped at ~1 MB, and the photo shares that document
// with the rest of the coffee. Anything approaching the cap fails to sync at
// all, so re-encode at lower quality until it comfortably fits.
const PHOTO_BUDGET_BYTES = 350 * 1024;

function resizeImage(file, maxSide = 700, quality = 0.65) {
  return new Promise((resolve, reject) => {
    if (!file.type || !file.type.startsWith("image/")) {
      reject(new Error("not an image")); return;
    }
    if (file.size > 30 * 1024 * 1024) {
      reject(new Error("image too large")); return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const image = new Image();
      image.onerror = () => reject(new Error("bad image"));
      image.onload = () => {
        const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
        const w = Math.max(1, Math.round(image.width * scale));
        const h = Math.max(1, Math.round(image.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w; canvas.height = h;
        canvas.getContext("2d").drawImage(image, 0, 0, w, h);

        let q = quality;
        let out = canvas.toDataURL("image/jpeg", q);
        while (out.length > PHOTO_BUDGET_BYTES && q > 0.3) {
          q -= 0.1;
          out = canvas.toDataURL("image/jpeg", q);
        }
        resolve(out);
      };
      image.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

// --- coffee detail ----------------------------------------------------------
async function renderCoffee(id) {
  const c = await db.getCoffee(id);
  if (!c) { location.hash = "#/"; return; }
  loadStars();                       // needed before the star renders below
  const brews = (await db.brewsForCoffee(id)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const g = await db.getGrinder();

  const strip = brews.length ? dialInChart(brews) : "";

  const rows = brews.slice().reverse().map((b) =>
    `<tr class="brew-row" data-id="${b.id}">
       <td class="nowrap">${fmtDate(b.createdAt)}</td>
       <td class="nowrap">${METHOD_SHORT[b.method] || METHOD_LABEL[b.method]}</td>
       <td class="nowrap">${Number(b.grindSetting)}</td>
       <td class="nowrap">${verdictIcon(b.verdict)}</td>
       <td class="nowrap"><button class="link-btn del-brew" data-id="${b.id}" title="Delete this brew">✕</button></td>
     </tr>`
  ).join("");

  view.replaceChildren(el(`
    <div>
      <p><a href="#/" class="back">← All coffees</a></p>
      <div class="title-row">
        <div class="title-text">
          <h2>${esc(c.name)}</h2>
          ${c.roaster ? `<p class="roaster-line"><small class="roaster">${esc(c.roaster)}</small></p>` : ""}
        </div>
        <!-- photo and star stacked, centres on the same vertical axis -->
        ${safePhoto(c.photo)
          ? `<button type="button" id="photo-thumb" class="thumb-btn" title="View photo">
               <img src="${safePhoto(c.photo)}" alt="${esc(c.name)}">
             </button>`
          : `<button type="button" id="photo-add" class="icon-btn" title="Add a photo">📷</button>`}
      </div>
      <p class="subtitle-row">
        <small>${c.roast} · ${c.process}${c.origin ? " · " + esc(c.origin) : ""}${c.decaf ? " · decaf" : ""}</small>
        <button type="button" id="star-toggle" class="star-btn"
                aria-pressed="${isStarred(c.id) ? "true" : "false"}"
                title="${isStarred(c.id) ? "Starred" : "Star this coffee"}"
          >${starSvg(isStarred(c.id))}</button>
      </p>

      <section class="step method-step">
        <h3 class="step-title"><span class="step-num">☕</span> Brew this — pick a method</h3>
        <div class="method-pills">${METHODS.map((m) =>
          `<button data-m="${m}">${METHOD_LABEL[m]}</button>`).join("")}</div>
      </section>

      <h3 class="step-title" style="margin-top:1.5rem"><span class="step-num">📈</span> Dial-in history</h3>
      ${strip || "<p><small>No brews logged yet.</small></p>"}
      ${brews.length ? `<p class="scale-hint"><span>taller bar = coarser grind</span></p>
        <table><thead><tr><th>Date</th><th>Method</th><th>Grind</th><th>Result</th><th></th></tr></thead>
        <tbody>${rows}</tbody></table>` : ""}

      <div class="center-row" style="margin-top:2rem">
        <button id="toggle-visibility" class="toggle-pill"
                aria-pressed="${c.visibility === "private"}">
          ${c.visibility === "private" ? "Private" : "Shared"}
        </button>
      </div>
      <p class="explain" style="text-align:center">${c.visibility === "private"
        ? "Only on your devices. Not shared, and not training anyone else's recommendations."
        : "Shared with your household."}</p>

      <div class="center-row" style="margin-top:1.5rem; gap:.6rem">
        <button id="edit-coffee" class="link-btn">Edit details</button>
        <button id="archive-coffee" class="danger-link">Archive this coffee</button>
      </div>
    </div>`));

  view.querySelectorAll(".method-pills button").forEach((btn) =>
    btn.addEventListener("click", () => location.hash = `#/brew?coffee=${id}&method=${btn.dataset.m}`));

  // Delete a mis-logged brew — it would otherwise keep training the model wrong.
  view.querySelectorAll(".del-brew").forEach((btn) =>
    btn.addEventListener("click", async (ev) => {
      ev.stopPropagation();     // don't also open the detail popup
      if (!confirm("Delete this brew? It will stop influencing recommendations.")) return;
      await db.softDelete("brew", btn.dataset.id);
      safeRoute();
    }));

  // Tap a row to see everything that was logged for that brew.
  view.querySelectorAll(".brew-row").forEach((row) =>
    row.addEventListener("click", () => {
      const brew = brews.find((b) => String(b.id) === row.dataset.id);
      if (brew) openBrewDetail(brew, c, g);
    }));

  view.querySelector("#edit-coffee").addEventListener("click",
    () => { location.hash = `#/coffee/${id}/edit`; });

  view.querySelector("#toggle-visibility").addEventListener("click", async () => {
    const goingPrivate = c.visibility !== "private";
    const msg = goingPrivate
      ? `Make "${c.name}" private?\n\nIt and its ${brews.length} brew(s) will be removed from the shared household — they'll disappear from the other person's device and stop affecting their recommendations.`
      : `Share "${c.name}" with your household?\n\nIt and its ${brews.length} brew(s) will become visible to the other person and will train their recommendations.`;
    if (!confirm(msg)) return;
    try {
      await sync.setCoffeeVisibility(c.id, goingPrivate ? "private" : "shared");
      toast(goingPrivate ? "Now private" : "Now shared");
      safeRoute();
    } catch (e) {
      console.error("[visibility]", e);
      alert("Couldn't change visibility: " + (e.message || e));
    }
  });

  view.querySelector("#archive-coffee").addEventListener("click", async () => {
    if (!confirm(`Archive "${c.name}"? Its brews stay in history but it leaves your list.`)) return;
    await db.updateCoffee({ ...c, archived: 1 });
    location.hash = "#/";
  });

  // star toggle — local to this device, so it never touches the shared record
  const star = view.querySelector("#star-toggle");
  star.addEventListener("click", () => {
    const nowStarred = toggleStar(c.id);
    star.innerHTML = starSvg(nowStarred);
    star.setAttribute("aria-pressed", String(nowStarred));
    star.title = nowStarred ? "Starred" : "Star this coffee";
  });

  // photo: thumbnail opens the lightbox; camera button adds one
  const thumb = view.querySelector("#photo-thumb");
  if (thumb) thumb.addEventListener("click", () => openPhotoLightbox(c));
  const addBtn = view.querySelector("#photo-add");
  if (addBtn) addBtn.addEventListener("click", () => pickPhoto(c));
}

/**
 * Dial-in chart: grind setting over time, one line per brew method, points
 * coloured by how the brew tasted.
 *
 * A line chart (rather than the old bars) because the useful question is
 * "which way am I drifting, and have I settled?" — that's a trend over
 * successive brews, which a line shows and isolated bars don't. The y-axis is
 * scaled to the range you've actually used, not the whole grinder, so small
 * adjustments stay visible.
 */
function dialInChart(brews) {
  const W = 320, H = 130, padL = 26, padR = 8, padT = 10, padB = 18;
  const byMethod = {};
  brews.forEach((b) => (byMethod[b.method] ||= []).push(b));

  const values = brews.map((b) => b.grindSetting);
  let lo = Math.min(...values), hi = Math.max(...values);
  if (hi === lo) { lo -= 1; hi += 1; }          // flat line: give it room
  const padY = (hi - lo) * 0.15;
  lo -= padY; hi += padY;

  const n = brews.length;
  const x = (i) => padL + (n === 1 ? (W - padL - padR) / 2
                                   : (i / (n - 1)) * (W - padL - padR));
  const y = (v) => padT + (1 - (v - lo) / (hi - lo)) * (H - padT - padB);

  // index every brew chronologically so lines share one x-axis
  const idx = new Map(brews.map((b, i) => [b.id, i]));
  const COLOURS = ["var(--gw-accent)", "#4a7fa5", "#6a8f4a", "#8a5f9a", "#a5744a"];

  let paths = "", dots = "", legend = "";
  Object.entries(byMethod).forEach(([method, list], mi) => {
    const colour = COLOURS[mi % COLOURS.length];
    const pts = list.map((b) => `${x(idx.get(b.id)).toFixed(1)},${y(b.grindSetting).toFixed(1)}`);
    if (pts.length > 1) {
      paths += `<polyline points="${pts.join(" ")}" fill="none" stroke="${colour}"
                 stroke-width="1.6" stroke-linejoin="round" opacity=".85"/>`;
    }
    list.forEach((b) => {
      // No stroke: the method-coloured ring fought with the fill and made the
      // dots hard to read. Fills are tuned to the emoji used in the Result
      // column so the chart and the table read as the same language.
      const cx = x(idx.get(b.id)), cy = y(b.grindSetting);
      // base fill, then a soft top-centred gloss (radial gradient, defined once
      // in <defs>) so it blends like the emoji circles rather than reading as a
      // second hard dot.
      dots += `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}"
                r="3.6" fill="${VERDICT_DOT[b.verdict] || colour}"/>` +
              `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}"
                r="3.6" fill="url(#dotGloss)"/>`;
    });
    legend += `<span class="legend-item"><i style="background:${colour}"></i>${METHOD_LABEL[method]}</span>`;
  });

  // y-axis: just the extremes, enough to read the scale without clutter
  const axis = `
    <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${H - padB}" stroke="var(--pico-muted-border-color)"/>
    <text x="${padL - 4}" y="${padT + 4}" class="ax">${hi.toFixed(1)}</text>
    <text x="${padL - 4}" y="${H - padB}" class="ax">${lo.toFixed(1)}</text>`;

  const good = brews.filter((b) => b.verdict === "good").length;
  const latest = brews[brews.length - 1];

  return `
    <svg class="dial-chart" viewBox="0 0 ${W} ${H}" role="img"
         aria-label="Grind setting over time">
      <defs>
        <radialGradient id="dotGloss" cx="50%" cy="24%" r="78%">
          <stop offset="0%"   stop-color="#fff" stop-opacity=".34"/>
          <stop offset="38%"  stop-color="#fff" stop-opacity=".16"/>
          <stop offset="70%"  stop-color="#fff" stop-opacity=".05"/>
          <stop offset="100%" stop-color="#fff" stop-opacity="0"/>
        </radialGradient>
      </defs>${axis}${paths}${dots}</svg>
    <div class="legend">${legend}</div>
    <div class="chart-stats">
      <span><strong>${brews.length}</strong> brew${brews.length === 1 ? "" : "s"}</span>
      <span><strong>${Math.round((good / brews.length) * 100)}%</strong> good</span>
      <span>last <strong>${latest.grindSetting}</strong> ${verdictIcon(latest.verdict)}</span>
    </div>`;
}

// Open the file picker, resize, and save onto the coffee.
function pickPhoto(coffee) {
  const input = el(`<input type="file" accept="image/*" hidden>`);
  document.body.appendChild(input);
  input.addEventListener("change", async () => {
    const file = input.files && input.files[0];
    input.remove();
    if (!file) return;
    try {
      const photo = await resizeImage(file, 700, 0.65);
      await db.updateCoffee({ ...coffee, photo });
      toast("Photo saved");
      safeRoute();
    } catch (err) {
      console.error("[photo]", err);
      toast("Couldn't read that image");
    }
  });
  input.click();
}

// Everything that was recorded for one brew. Fields that weren't filled in are
// omitted rather than shown blank.
function openBrewDetail(b, coffee, grinder) {
  const rows = [
    ["Date", new Date(b.createdAt).toLocaleString()],
    ["Coffee", coffee.name],
    ["Roaster", coffee.roaster || null],
    ["Method", METHOD_LABEL[b.method]],
    ["Grind", `${b.grindSetting} (of ${grinder.min}–${grinder.max})`],
    ["Result", verdictLabel(b.verdict)],
    ["Dose", b.doseG != null ? `${b.doseG} g` : null],
    ["Yield", b.yieldG != null ? `${b.yieldG} g` : null],
    ["Ratio", (b.doseG && b.yieldG) ? `1:${(b.yieldG / b.doseG).toFixed(1)}` : null],
    ["Shot time", b.shotTimeS != null ? `${b.shotTimeS} s` : null],
    ["Brew time", b.brewTimeS != null ? `${b.brewTimeS} s` : null],
    ["Water", b.waterTempC != null ? `${b.waterTempC} °C` : null],
  ].filter(([, v]) => v != null && v !== "");

  const overlay = el(`
    <div class="lightbox" id="brew-detail">
      <div class="lightbox-inner sheet">
        <h3 style="margin:0 0 .75rem">Brew detail</h3>
        <table class="detail-table"><tbody>
          ${rows.map(([k, v]) => `<tr><th>${k}</th><td>${esc(v)}</td></tr>`).join("")}
        </tbody></table>
        <p class="lightbox-hint">Tap anywhere to close</p>
      </div>
    </div>`);
  document.body.appendChild(overlay);
  overlay.addEventListener("click", () => overlay.remove());
}

// Tap-to-enlarge overlay with Replace / Remove. Tapping the backdrop closes it.
function openPhotoLightbox(coffee) {
  const overlay = el(`
    <div class="lightbox" id="lightbox">
      <div class="lightbox-inner">
        <img src="${safePhoto(coffee.photo) || ""}" alt="${esc(coffee.name)}">
        <div class="lightbox-actions">
          <button type="button" id="lb-replace">Replace photo</button>
          <button type="button" id="lb-remove" class="danger-solid">Remove photo</button>
        </div>
        <p class="lightbox-hint">Tap anywhere to close</p>
      </div>
    </div>`);
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  // Tapping ANYWHERE closes — including the photo itself. Only the action
  // buttons swallow the tap, so they don't dismiss before they run.
  overlay.addEventListener("click", close);
  overlay.querySelector(".lightbox-actions")
    .addEventListener("click", (e) => e.stopPropagation());

  overlay.querySelector("#lb-replace").addEventListener("click", () => {
    close(); pickPhoto(coffee);
  });
  overlay.querySelector("#lb-remove").addEventListener("click", async () => {
    if (!confirm("Remove this photo?")) return;
    await db.updateCoffee({ ...coffee, photo: null });
    close(); toast("Photo removed"); safeRoute();
  });
}

// --- brew (the core screen) -------------------------------------------------

// The suggestion's uncertainty, drawn as a ruler of real grinder clicks.
//
// Every tick is one step of the user's own grinder, so the width of the dark
// band is literally "how many clicks you might still have to move" — the unit
// they physically turn, rather than an abstract bar. The centre tick is the
// suggestion. Ticks inside the plausible range stay accented; the rest fade to
// the border colour to give the ruler its extent without shouting.
//
// The scale is FIXED at one tick per step. A self-scaling widget would look
// identical at every level of certainty, and the entire point is watching the
// band narrow to a single tick as a bag gets dialled in.
function recTrack(setting, range, grinder) {
  const step = Number(grinder.step) || 0.5;
  const N = 17;                          // odd, so there is a true centre tick
  const half = (N - 1) / 2;
  const gap = 10, W = N * gap, H = 26, baseY = 21;
  const cx = W / 2;

  // how many steps either side are plausible (0 once dialled in)
  const reach = Array.isArray(range) && range.length === 2
    ? Math.max(Math.abs(setting - range[0]), Math.abs(range[1] - setting)) / step
    : 0;

  let ticks = "";
  for (let i = 0; i < N; i++) {
    const k = i - half;
    const x = (cx + k * gap).toFixed(1);
    const centre = k === 0;
    const inBand = Math.abs(k) <= reach + 0.001;
    const h = centre ? 17 : (inBand ? 10 : 6);
    const stroke = centre ? "var(--gw-accent)"
      : (inBand ? "var(--gw-accent)" : "var(--pico-muted-border-color)");
    const op = centre ? 1 : (inBand ? 0.45 : 1);
    ticks += `<line x1="${x}" y1="${baseY - h}" x2="${x}" y2="${baseY}"
                    stroke="${stroke}" stroke-opacity="${op}"
                    stroke-width="${centre ? 3 : 1.6}" stroke-linecap="round"/>`;
  }

  const label = Array.isArray(range)
    ? `likely ${range[0]} to ${range[1]}` : "dialled in";
  return `<svg class="rec-track" viewBox="0 0 ${W} ${H}" role="img"
               aria-label="${label}">${ticks}</svg>`;
}

async function renderBrew(coffeeId, method) {
  method = method || "espresso";
  const c = await db.getCoffee(coffeeId);
  const g = await db.getGrinder();
  if (!c) { location.hash = "#/"; return; }

  // NOTE: this header block deliberately mirrors renderCoffee() exactly — same
  // back link, title row, subtitle and method section — so navigating from the
  // coffee page to here doesn't visually shift the pills.
  view.replaceChildren(el(`
    <div>
      <p><a href="#/coffee/${c.id}" class="back">← All coffees</a></p>
      <div class="title-row">
        <div class="title-text">
          <h2>${esc(c.name)}</h2>
          ${c.roaster ? `<p class="roaster-line"><small class="roaster">${esc(c.roaster)}</small></p>` : ""}
        </div>
        ${safePhoto(c.photo)
          ? `<button type="button" id="photo-thumb" class="thumb-btn" title="View photo">
               <img src="${safePhoto(c.photo)}" alt="${esc(c.name)}">
             </button>`
          : `<span class="thumb-spacer"></span>`}
      </div>
      <p class="subtitle-row">
        <small>${c.roast} · ${c.process}${c.origin ? " · " + esc(c.origin) : ""}${c.decaf ? " · decaf" : ""}</small>
        <span class="star-spacer"></span>
      </p>

      <section class="step method-step">
        <h3 class="step-title"><span class="step-num">☕</span> Brew this — pick a method</h3>
        <div class="method-pills" id="pills">${METHODS.map((m) =>
          `<button data-m="${m}" ${m === method ? 'aria-current="true"' : ""}>${METHOD_LABEL[m]}</button>`).join("")}</div>
      </section>

      <section class="step">
        <h3 class="step-title"><span class="step-num">1</span> Suggested grind</h3>
        <div class="rec-wrap" id="rec"><progress></progress></div>
      </section>

      <section class="step">
        <h3 class="step-title"><span class="step-num">2</span> What did you actually use?</h3>
        <label>Grind setting
          <input id="grind" type="number" step="${g.step}" min="${g.min}" max="${g.max}"
                 inputmode="decimal" value="">
        </label>
        <details id="extras"></details>
      </section>

      <section class="step">
        <h3 class="step-title"><span class="step-num">3</span> How did it taste?</h3>
        ${method === "espresso" ? `
        <div class="verdict-row five">
          <button class="v-gusher" data-v="gusher">💨<br>Ran<br>through</button>
          <button class="v-under" data-v="under">🟠<br>Sour</button>
          <button class="v-good" data-v="good">🟢<br>Good</button>
          <button class="v-over" data-v="over">🔴<br>Bitter</button>
          <button class="v-choked" data-v="choked">🧱<br>Choked</button>
        </div>` : `
        <div class="verdict-row">
          <button class="v-under" data-v="under">🟠<br>Sour / weak</button>
          <button class="v-good" data-v="good">🟢<br>Good</button>
          <button class="v-over" data-v="over">🔴<br>Bitter / harsh</button>
        </div>`}
        <p class="scale-hint"><span>← grind finer</span><span>grind coarser →</span></p>
      </section>
    </div>`));

  // carry forward the settings from the last brew of this coffee+method
  const priorBrews = (await db.brewsForCoffee(coffeeId))
    .filter((b) => b.method === method)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  renderExtras(method, priorBrews[priorBrews.length - 1] || null);

  const pills = view.querySelector("#pills");
  pills.querySelectorAll("button").forEach((b) =>
    b.addEventListener("click", () => location.hash = `#/brew?coffee=${coffeeId}&method=${b.dataset.m}`));

  const brewThumb = view.querySelector("#photo-thumb");
  if (brewThumb) brewThumb.addEventListener("click", () => openPhotoLightbox(c));

  // fetch recommendation from the Python engine
  // Strip photos: the engine never uses them, and base64 images would make the
  // JSON crossing into Python needlessly huge on every recommendation.
  const coffeesForEngine = (await db.allCoffeesIncludingArchived())
    .map(({ photo, ...rest }) => rest);

  const payload = {
    grinder: g,
    // include archived coffees: their brews are still valid training data
    coffees: coffeesForEngine,
    brews: await db.allBrews(),
    request: { coffeeId: String(coffeeId), method },
  };
  let rec, recError = null;
  try { rec = await recommend(payload); }
  catch (e) { console.error("[recommend]", e); rec = null; recError = e.message || String(e); }

  const recEl = view.querySelector("#rec");
  if (rec) {
    // Everything that used to stack up under the number — confidence, the range
    // in words, where the starting point came from, the feature contributions —
    // now lives behind "why?". Three of those were answers to the same question
    // ("how sure are you?"), and the track above answers it without words.
    const hasRange = Array.isArray(rec.range) && rec.range.length === 2;
    const detail = [
      ["Confidence", rec.confidence],
      ["Likely range", hasRange ? `${rec.range[0]}–${rec.range[1]}` : "dialled in"],
      ["Based on", rec.nudge || "coffee characteristics"],
      ...(rec.explanation || []).map((x) =>
        [x.label, `${x.delta > 0 ? "+" : ""}${x.delta}`]),
    ];
    recEl.replaceChildren(el(`
      <div>
        <div class="rec-number">${rec.setting}</div>
        ${recTrack(rec.setting, rec.range, g)}
        <details class="rec-why">
          <summary class="explain">why?</summary>
          <table class="detail-table"><tbody>
            ${detail.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join("")}
          </tbody></table>
        </details>
      </div>`));
    view.querySelector("#grind").value = rec.setting;
  } else {
    recEl.innerHTML = `<p><small>No recommendation yet — you can still log this brew
      and it will be used for training.</small></p>
      <details><summary class="explain">why?</summary>
        <p class="explain">${esc(recError || "engine not ready")}</p>
        <button id="retry-engine" class="secondary">Retry engine</button>
      </details>`;
    const rb = recEl.querySelector("#retry-engine");
    if (rb) rb.addEventListener("click", () => safeRoute());
  }

  view.querySelectorAll(".verdict-row button").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const input = view.querySelector("#grind");
      const grind = parseFloat(input.value);
      if (isNaN(grind)) {
        input.focus();
        input.scrollIntoView({ behavior: "smooth", block: "center" });
        toast("Enter the grind setting you used");
        return;
      }
      const extra = collectExtras(method);
      await db.addBrew({ coffeeId: String(coffeeId), method, grindSetting: grind, verdict: btn.dataset.v, ...extra });
      toast(`Logged ${grind} · ${verdictLabel(btn.dataset.v)}`);
      location.hash = `#/coffee/${coffeeId}`;
    }));
}

// `last` is the previous brew of this coffee+method, used to pre-fill the
// values that stay the same from brew to brew (dose, water temp). Yield and
// time are deliberately left blank — they're outcomes, not settings.
function renderExtras(method, last = null) {
  const d = view.querySelector("#extras");
  if (!d) return;
  const prefill = (v) => (v == null || v === "" ? "" : ` value="${v}"`);
  const dose = prefill(last && last.doseG);
  const temp = prefill(last && last.waterTempC);
  if (last && (last.doseG != null || last.waterTempC != null)) {
    d.open = true;   // show it, so the carried-over values are visible
  }
  if (method === "espresso") {
    d.innerHTML = `<summary>Shot detail (optional)</summary>
      <div class="grid">
        <label>Dose (g) <input id="doseG" type="number" step="any" inputmode="decimal"${dose}></label>
        <label>Yield (g) <input id="yieldG" type="number" step="any" inputmode="decimal"></label>
        <label>Time (s) <input id="shotTimeS" type="number" step="any" inputmode="decimal"></label>
      </div>`;
  } else {
    d.innerHTML = `<summary>Brew detail (optional)</summary>
      <div class="grid">
        <label>Dose (g) <input id="doseG" type="number" step="any" inputmode="decimal"${dose}></label>
        <label>Time (s) <input id="brewTimeS" type="number" step="any" inputmode="decimal"></label>
        <label>Water (°C) <input id="waterTempC" type="number" step="any" inputmode="decimal"${temp}></label>
      </div>`;
  }
}
function collectExtras(method) {
  const num = (id) => { const e = view.querySelector("#" + id); const v = e && e.value; return v ? +v : null; };
  const out = {};
  ["doseG", "yieldG", "shotTimeS", "brewTimeS", "waterTempC"].forEach((k) => {
    const v = num(k); if (v != null) out[k] = v;
  });
  return out;
}

// --- history ----------------------------------------------------------------
async function renderHistory() {
  const brews = (await db.allBrews()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  // include archived coffees here so old brews still show a name, not "?"
  const all = await db.allCoffeesIncludingArchived();
  const coffees = Object.fromEntries(all.map((c) => [String(c.id), c]));
  const rows = brews.map((b) =>
    `<tr class="brew-row" data-id="${b.id}">
       <td class="nowrap">${fmtDate(b.createdAt)}</td>
       <td class="truncate">${esc(coffees[String(b.coffeeId)]?.name || "—")}${
         coffees[String(b.coffeeId)]?.roaster
           ? `<br><small class="roaster">${esc(coffees[String(b.coffeeId)].roaster)}</small>` : ""}</td>
       <td class="nowrap">${METHOD_SHORT[b.method] || METHOD_LABEL[b.method]}</td>
       <td class="nowrap">${Number(b.grindSetting)}</td>
       <td class="nowrap">${verdictIcon(b.verdict)}</td>
     </tr>`
  ).join("");
  view.replaceChildren(el(`<div><h2>History</h2>${brews.length
    ? `<table class="compact"><thead><tr><th>Date</th><th>Coffee</th><th>Method</th><th>Grind</th><th></th></tr></thead><tbody>${rows}</tbody></table>
       <p class="explain" style="text-align:center">Tap a brew for full detail.</p>`
    : "<p><small>No brews logged yet.</small></p>"}</div>`));

  // same detail sheet as the coffee page
  const g = await db.getGrinder();
  view.querySelectorAll(".brew-row").forEach((row) =>
    row.addEventListener("click", () => {
      const brew = brews.find((b) => String(b.id) === row.dataset.id);
      if (!brew) return;
      const coffee = coffees[String(brew.coffeeId)] || { name: "—" };
      openBrewDetail(brew, coffee, g);
    }));
}

// --- settings ---------------------------------------------------------------
async function renderSettings() {
  const g = await db.getGrinder();
  view.replaceChildren(el(`
    <div>
      <div class="title-row settings-head">
        <h2>Settings</h2>
        <span class="badge-row">
          <span id="sync-badge" class="badge" hidden></span>
          <span id="engine-badge" class="badge">engine: loading</span>
        </span>
      </div>
      <article class="inline-row">
        <span>
          <strong>Version</strong> ${APP_VERSION}
          <br><small id="update-status">Checking for updates…</small>
        </span>
        <button id="force-update" class="secondary compact-btn" hidden>Update</button>
      </article>
      <article id="sync-panel"><strong>Sharing</strong><p><small>Loading…</small></p></article>
      <article>
        <div><strong>Grinder:</strong> ${esc(g.name)} (${g.min}–${g.max}, step ${g.step})</div>
        ${g.calibration
          ? `<div><strong>Calibrated:</strong> ${METHOD_LABEL[g.calibration.method]} @ ${g.calibration.setting}</div>`
          : `<div><small>Not calibrated</small></div>`}
        <div class="center-link"><a href="#/setup">Edit grinder</a></div>
      </article>
      <article>
        <strong>Backup</strong>
        <p><small>Your phone can clear local data. Export a JSON backup now and then.</small></p>
        <button id="export">Export backup</button>
        <div class="inline-row">
          <span>Import backup</span>
          <button id="import-btn" class="secondary compact-btn">Choose file</button>
          <input id="import" type="file" accept="application/json" hidden>
        </div>
      </article>
    </div>`));
  paintBadges();                     // the nodes are new on every render

  view.querySelector("#export").addEventListener("click", async () => {
    const data = await db.exportAll();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `morning-glory-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
  });
  view.querySelector("#import").addEventListener("change", async (e) => {
    const file = e.target.files[0]; if (!file) return;
    try {
      if (file.size > 25 * 1024 * 1024) throw new Error("file too large");
      const data = JSON.parse(await file.text());
      const r = await db.importAll(data);
      alert(`Imported ${r.coffees} coffee(s) and ${r.brews} brew(s).` +
            (r.skipped > 0 ? `\n${r.skipped} unreadable record(s) were skipped.` : ""));
      location.hash = "#/";
    } catch (err) {
      console.error("[import]", err);
      alert("Couldn't import that file: " + (err.message || err));
    } finally {
      e.target.value = "";   // let the same file be re-picked after a failure
    }
  });

  const fu = view.querySelector("#force-update");
  if (fu) fu.addEventListener("click", async () => {
    // Nuke caches + service worker so the next load is guaranteed fresh.
    if ("serviceWorker" in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
    if (window.caches) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
    location.reload(true);
  });

  view.querySelector("#import-btn").addEventListener("click", () =>
    view.querySelector("#import").click());

  checkForUpdate();
  await renderSyncPanel();
}

// Sign-in / household / invite-code panel inside Settings.
async function renderSyncPanel() {
  const panel = document.getElementById("sync-panel");
  if (!panel) return;
  const st = sync.status();

  if (!st.available) {
    panel.innerHTML = `<strong>Sharing</strong>
      <p><small>Sync isn't configured, so the app is running locally on this
      device only.</small></p>`;
    return;
  }

  if (!st.signedIn) {
    panel.innerHTML = `<strong>Sharing</strong>
      <p><small>Sign in to sync your coffees and brews across devices and share
      with someone.</small></p>
      <button id="signin">Sign in with Google</button>
      <p id="auth-err" class="explain"></p>`;
    const errBox = panel.querySelector("#auth-err");
    if (sync.lastAuthError()) errBox.textContent = "Last error: " + sync.lastAuthError();
    panel.querySelector("#signin").addEventListener("click", () =>
      sync.signIn().catch((e) => {
        console.error("[signin]", e);
        const code = e.code || "";
        if (code.includes("popup-closed") || code.includes("cancelled")) return;
        errBox.textContent = "Sign-in failed: " + (code || e.message);
      }));
    return;
  }

  if (!st.householdId) {
    panel.innerHTML = `<div class="panel-head">
        <strong>Sharing</strong>
        <small class="who">${esc(st.user.name || st.user.email)}</small>
      </div>
      <p><small>Create a household and share the code, or join one.</small></p>
      <button id="create">Create household</button>
      <div class="inline-row">
        <span>Join with code</span>
        <input id="joincode" placeholder="6 chars" maxlength="6"
               style="text-transform:uppercase;width:7rem">
        <button id="join" class="secondary compact-btn">Join</button>
      </div>
      <p class="center-link"><a href="#" id="signout">Sign out</a></p>`;
    panel.querySelector("#create").addEventListener("click", async () => {
      try {
        const code = await sync.createHousehold();
        alert("Household created. Invite code: " + code);
        renderSettings();
      } catch (e) { alert("Failed: " + e.message); }
    });
    panel.querySelector("#join").addEventListener("click", async () => {
      try {
        await sync.joinHousehold(panel.querySelector("#joincode").value);
        toast("Joined household");
        renderSettings();
      } catch (e) { alert("Join failed: " + e.message); }
    });
    panel.querySelector("#signout").addEventListener("click", async (ev) => {
      ev.preventDefault(); await sync.signOutUser(); renderSettings();
    });
    return;
  }

  const code = await sync.getInviteCode();
  panel.innerHTML = `<div class="panel-head">
      <strong>Sharing</strong>
      <small class="who">${esc(st.user.name || st.user.email)}</small>
    </div>
    <div class="inline-row">
      <span>Invite code</span>
      <strong class="invite-code">${esc(code || "—")}</strong>
    </div>
    <p class="invite-hint"><small>Share this code. They sign in and tap Join.</small></p>
    <p class="center-link"><a href="#" id="signout">Sign out</a></p>`;
  panel.querySelector("#signout").addEventListener("click", async (ev) => {
    ev.preventDefault(); await sync.signOutUser(); renderSettings();
  });
  initHolo(panel.querySelector(".invite-code"));
}

// --- motion permission ------------------------------------------------------
// iOS 13+ refuses DeviceOrientation without an explicit grant, and only prompts
// from inside a user gesture.
//
// The grant CANNOT be made to stick: Safari re-prompts on every page load, and
// storing "granted" doesn't help because it is the requestPermission() call
// itself that raises the dialog. Arming this at boot therefore meant a system
// prompt every single launch — for a decorative shimmer. So it is now asked for
// only when someone deliberately taps the invite code, and the stored "denied"
// stops it being offered again at all.
const MOTION_KEY = "mg.motionPermission";
let motionPromise = null;

const needsNoPermission = () => {
  const D = window.DeviceOrientationEvent;
  return !D || typeof D.requestPermission !== "function";
};
const motionDenied = () => {
  try { return localStorage.getItem(MOTION_KEY) === "denied"; } catch { return false; }
};

function ensureMotionPermission() {
  if (motionPromise) return motionPromise;

  const D = window.DeviceOrientationEvent;
  // Android/desktop: no gate at all, orientation just works (or doesn't exist,
  // which the caller's watchdog handles).
  if (!D || typeof D.requestPermission !== "function") {
    motionPromise = Promise.resolve(true);
    return motionPromise;
  }

  let remembered = null;
  try { remembered = localStorage.getItem(MOTION_KEY); } catch {}
  // Don't nag someone who already said no.
  if (remembered === "denied") { motionPromise = Promise.resolve(false); return motionPromise; }

  motionPromise = new Promise((resolve) => {
    // Several event types, not just pointerdown. WebKit only treats certain
    // events as a "user activation" for gated APIs, and pointerdown alone was
    // being rejected — which left the promise pending forever and the foil
    // frozen. click/touchend are the reliable ones; the rest are belt and braces.
    const EVENTS = ["click", "touchend", "pointerup", "keydown"];
    const arm = () => EVENTS.forEach((t) =>
      document.addEventListener(t, ask, { once: true, capture: true }));
    const disarm = () => EVENTS.forEach((t) =>
      document.removeEventListener(t, ask, { capture: true }));

    let asking = false;
    async function ask() {
      if (asking) return;
      asking = true;
      disarm();
      try {
        const res = await D.requestPermission();
        const ok = res === "granted";
        try { localStorage.setItem(MOTION_KEY, ok ? "granted" : "denied"); } catch {}
        resolve(ok);
      } catch (e) {
        // Not gesture-initiated after all. Re-arm and let the next one try.
        console.warn("[motion]", e);
        asking = false;
        arm();
      }
    }

    arm();
  });
  return motionPromise;
}

// --- holographic invite code ------------------------------------------------
// Tilt-driven: the foil and the specular streak are positioned from
// --holo-x / --holo-y and nothing moves unless the phone does.
//
// The iOS permission gate lives in ensureMotionPermission() above, asked for
// on tap — this only has to deal with the sensor itself. Two things it still owns:
//   * detaching the previous listener. The Sharing panel re-renders on every
//     sync tick, and without this they stack up.
//   * a watchdog. Permission can be granted and still deliver nothing (iOS has
//     a system-level Motion & Orientation switch, desktop has no sensor), so if
//     no reading arrives the idle shimmer starts rather than the code sitting
//     there looking broken.
let holoDetach = null;

function initHolo(node) {
  if (holoDetach) { holoDetach(); holoDetach = null; }
  if (!node || !node.textContent.trim() || node.textContent.trim() === "—") return;

  // the ::after sheen re-renders the same text, so it needs it as an attribute
  node.dataset.code = node.textContent.trim();

  const D = window.DeviceOrientationEvent;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const idle = () => { if (!reduced) node.classList.add("holo-idle"); };

  if (!D) { idle(); return; }

  const clamp = (v) => Math.max(-1, Math.min(1, v));
  let targetX = 0, targetY = 0, curX = 0, curY = 0, raf = 0, live = false;
  let baseG = null, baseB = null;

  const onOrient = (e) => {
    if (e.gamma == null && e.beta == null) return;
    if (!live) { live = true; node.classList.remove("holo-idle"); }

    const g = e.gamma || 0, b = e.beta || 0;

    // Calibrate to however the phone is being held RIGHT NOW, then respond to
    // change from there. Reading gamma/beta absolutely (with a hardcoded "45°
    // is neutral") meant the sheen sat pinned at one extreme for anyone not
    // holding the phone at exactly that angle, so small movements did nothing —
    // which is what made it feel unresponsive.
    if (baseG === null) { baseG = g; baseB = b; }

    // Baseline creeps toward the current pose, so holding still returns the
    // hotspot to the middle and the next movement always has room to travel.
    baseG += (g - baseG) * 0.004;
    baseB += (b - baseB) * 0.004;

    targetX = clamp((g - baseG) / 32);
    targetY = clamp((b - baseB) / 32);
  };

  const frame = () => {
    raf = requestAnimationFrame(frame);
    if (!live) return;
    // exponential smoothing. Low factor: the sensor delivers coarse, unevenly
    // spaced readings, and following them closely is what read as jerky. This
    // eases between them instead, at the cost of a few frames of lag.
    curX += (targetX - curX) * 0.075;
    curY += (targetY - curY) * 0.075;
    // Y inverted: tipping the top of the phone away pushes the hotspot up the
    // text, the way a reflection of a fixed light behaves.
    node.style.setProperty("--holo-x", `${50 + curX * 60}%`);
    node.style.setProperty("--holo-y", `${50 - curY * 60}%`);
  };

  const attach = () => {
    window.addEventListener("deviceorientation", onOrient);
    raf = requestAnimationFrame(frame);
    // no readings => no sensor, or iOS Settings › Safari › Motion & Orientation
    // Access is off. Shimmer anyway rather than sitting there looking dead.
    const watchdog = setTimeout(() => { if (!live) idle(); }, 1500);
    holoDetach = () => {
      window.removeEventListener("deviceorientation", onOrient);
      cancelAnimationFrame(raf);
      clearTimeout(watchdog);
    };
  };

  if (reduced) return;

  // Default state is the shimmer — it looks like foil without asking for
  // anything. Tilt is opt-in, per launch, by tapping the code.
  if (motionPromise || needsNoPermission()) {
    // already settled this session (or no gate on this platform)
    ensureMotionPermission().then((ok) => {
      if (!ok) { idle(); return; }
      if (node.isConnected) attach();
    });
    return;
  }

  idle();
  if (motionDenied()) return;                 // asked before, said no
  node.title = "Tap for tilt";
  node.classList.add("holo-tappable");
  node.addEventListener("click", () => {
    ensureMotionPermission().then((ok) => {
      if (!ok || !node.isConnected) return;
      node.classList.remove("holo-tappable", "holo-idle");
      node.removeAttribute("title");
      attach();
    });
  }, { once: true });
}

// Compare the running build against version.json on the server (fetched with
// cache:no-store so the service worker can't answer with a stale copy).
async function checkForUpdate() {
  const status = document.getElementById("update-status");
  const btn = document.getElementById("force-update");
  if (!status) return;
  try {
    const res = await fetch(`./version.json?t=${Date.now()}`, { cache: "no-store" });
    const { version } = await res.json();
    if (version && version !== APP_VERSION) {
      status.textContent = `Update available (${version})`;
      status.className = "update-available";
      if (btn) btn.hidden = false;
    } else {
      status.textContent = "Up to date";
      status.className = "update-ok";
      if (btn) btn.hidden = true;
    }
  } catch {
    status.textContent = "Couldn't check (offline)";
    status.className = "";
    if (btn) btn.hidden = false;   // let the user force it anyway
  }
}


// --- helpers ----------------------------------------------------------------
function verdictLabel(v) { return { gusher: "💨 Ran through", under: "🟠 Sour",
  good: "🟢 Good", over: "🔴 Bitter", choked: "🧱 Choked" }[v] || v; }
// Chart dot colours, matched to the Result-column emoji (🟠 🟢 🔴 💨 🧱) so the
// two views agree at a glance.
const VERDICT_DOT = {
  under:  "#f5a623",   // 🟠
  good:   "#4caf50",   // 🟢
  over:   "#e53935",   // 🔴
  gusher: "#9aa7b0",   // 💨
  choked: "#a6503c",   // 🧱
};

// icon-only for narrow table columns
function verdictIcon(v) { return { gusher: "💨", under: "🟠", good: "🟢",
  over: "🔴", choked: "🧱" }[v] || v; }

// dd/mm/yy — compact and unambiguous for a UK-style reader
function fmtDate(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return String(iso).slice(0, 10);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${String(d.getFullYear()).slice(-2)}`;
}

let toastTimer = null;
function toast(msg) {
  let t = document.getElementById("toast");
  if (!t) {
    t = el(`<div id="toast" class="toast" role="status" aria-live="polite"></div>`);
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2200);
}
// --- hold-and-drag reordering ----------------------------------------------
// Pointer Events so one code path covers touch and mouse.
//
// The cards are NOT re-parented while you drag. Everything is done with
// transforms: the held card follows the finger, and the cards it has passed
// slide out of the way by one card-height, which opens a visible gap showing
// exactly where it will land. The DOM is reordered once, on drop.
//
// Positions are measured in the SCROLLER's coordinate space (offsetTop plus
// scrollTop), not in viewport space. Viewport coordinates shift under you the
// moment the list auto-scrolls, which made the card jump away from the finger.
let justDragged = false;

function enableReorder(container, totalCount) {
  if (!container) return;

  // NOT const: a drop rewrites the DOM order, and every later drag has to work
  // from the new one. Reusing the list captured at render time meant the second
  // drag computed indices and travel limits against the OLD positions — the top
  // card would fly past the boundary and nothing could be dropped above it.
  let cards = [...container.querySelectorAll(".coffee-card")];
  // Reordering a filtered view would only describe the visible subset, so the
  // saved order would be wrong for everything hidden. Require the full list.
  if (cards.length < 2 || cards.length !== totalCount) return;

  const scroller = container.closest("main") || document.scrollingElement;

  const HOLD_MS = 320;      // long enough not to fire on a tap
  const MOVE_CANCEL = 8;    // px of movement that means "this is a scroll"
  const EDGE = 72;          // px from the edge where auto-scroll kicks in
  const MAX_STEP = 14;      // px per frame at full tilt

  let timer = null, held = null, heldIndex = -1, startY = 0;
  let metrics = [], shift = 0, targetIndex = -1;
  let minDy = 0, maxDy = 0, lastClientY = 0, scrollRaf = 0;

  // pointer position in scroller space, so it stays valid while auto-scrolling
  const py = (clientY) => clientY + scroller.scrollTop;

  // Block the page scrolling under the finger. Must be non-passive or
  // preventDefault() is ignored.
  container.addEventListener("touchmove", (e) => { if (held) e.preventDefault(); },
    { passive: false });

  const measure = () => {
    // re-read from the DOM: document order is visual order, which is what all
    // the index maths below assumes
    cards = [...container.querySelectorAll(".coffee-card")];
    heldIndex = cards.indexOf(held);
    metrics = cards.map((el) => ({
      el, top: el.offsetTop, height: el.offsetHeight,
      mid: el.offsetTop + el.offsetHeight / 2,
    }));
    const gap = metrics.length > 1
      ? Math.max(0, metrics[1].top - (metrics[0].top + metrics[0].height))
      : 8;
    shift = metrics[heldIndex].height + gap;

    // Travel limits. Aligning edge-to-edge with the end cards was too tight to
    // be usable: a swap only fires once the held card's MIDDLE passes the other
    // card's middle, and with edges flush those middles coincide (or worse, if
    // the held card is the taller of the two) — so first place was unreachable.
    // The limit therefore allows a deliberate overshoot past each end: enough
    // to clear the end card's midpoint, plus a bit of give. The cards being
    // displaced still only ever move by one slot, so nothing else leaves the
    // list.
    const held0 = metrics[heldIndex];
    const last = metrics[metrics.length - 1];
    const overshoot = (other) =>
      Math.max(held0.height * 0.6, (held0.height - other.height) / 2 + 8);

    minDy = (metrics[0].top - held0.top) - overshoot(metrics[0]);
    maxDy = (last.top + last.height) - (held0.top + held0.height) + overshoot(last);
  };

  const paint = (rawDy) => {
    const dy = Math.max(minDy, Math.min(maxDy, rawDy));
    held.style.transform = `translateY(${dy}px) scale(1.03)`;

    const heldMid = metrics[heldIndex].mid + dy;
    let moved = 0;
    metrics.forEach((m, i) => {
      if (i === heldIndex) return;
      // a card below the held one slides UP once the held card passes its
      // middle; a card above slides DOWN. Everything else stays put.
      const passed = i > heldIndex ? heldMid > m.mid : heldMid < m.mid;
      m.el.style.transform = passed
        ? `translateY(${i > heldIndex ? -shift : shift}px)` : "";
      if (passed) moved += i > heldIndex ? 1 : -1;
    });
    targetIndex = heldIndex + moved;
  };

  // Hold near the top or bottom edge and the list scrolls, so a card can be
  // moved past the end of a screenful without letting go.
  const autoScroll = () => {
    scrollRaf = requestAnimationFrame(autoScroll);
    if (!held) return;
    const r = scroller.getBoundingClientRect();
    let v = 0;
    if (lastClientY < r.top + EDGE) v = -MAX_STEP * (r.top + EDGE - lastClientY) / EDGE;
    else if (lastClientY > r.bottom - EDGE) v = MAX_STEP * (lastClientY - (r.bottom - EDGE)) / EDGE;
    if (!v) return;
    v = Math.max(-MAX_STEP, Math.min(MAX_STEP, v));
    const before = scroller.scrollTop;
    scroller.scrollTop += v;
    if (scroller.scrollTop !== before) paint(py(lastClientY) - startY);
  };

  const reset = () => {
    clearTimeout(timer); timer = null;
    cancelAnimationFrame(scrollRaf); scrollRaf = 0;
    cards.forEach((c) => { c.style.transform = ""; c.classList.remove("shifting"); });
    if (held) held.classList.remove("dragging");
    held = null; heldIndex = -1; targetIndex = -1;
  };

  const begin = (card, clientY) => {
    held = card;
    lastClientY = clientY;
    startY = py(clientY);
    measure();                       // sets heldIndex from the live DOM order
    card.classList.add("dragging");
    cards.forEach((c) => { if (c !== card) c.classList.add("shifting"); });
    window.getSelection?.()?.removeAllRanges();
    if (navigator.vibrate) navigator.vibrate(15);
    scrollRaf = requestAnimationFrame(autoScroll);
  };

  const drop = () => {
    if (!held) { reset(); return; }

    if (targetIndex >= 0 && targetIndex !== heldIndex) {
      const order = cards.filter((c) => c !== held);
      order.splice(targetIndex, 0, held);
      // one DOM write, after the gesture — no reflow mid-drag
      order.forEach((c) => container.appendChild(c));
      saveOrder(order.map((c) => c.dataset.id));
    }

    // Swallow the click this pointer sequence is about to fire, or dropping a
    // card opens it. A 0ms timeout was too early — the click lands later.
    justDragged = true;
    setTimeout(() => { justDragged = false; }, 400);

    reset();
  };

  cards.forEach((card) => {
    card.addEventListener("pointerdown", (e) => {
      if (e.button != null && e.button !== 0) return;
      const downX = e.clientX, downY = e.clientY;
      const pid = e.pointerId;

      const cancelHold = (ev) => {
        if (held) return;
        if (Math.abs(ev.clientY - downY) > MOVE_CANCEL
            || Math.abs(ev.clientX - downX) > MOVE_CANCEL) {
          clearTimeout(timer); timer = null;
        }
      };
      card.addEventListener("pointermove", cancelHold);
      card.addEventListener("pointerup", () =>
        card.removeEventListener("pointermove", cancelHold), { once: true });

      timer = setTimeout(() => {
        // capture AFTER the hold, so a plain scroll is never hijacked
        card.setPointerCapture?.(pid);
        begin(card, downY);
      }, HOLD_MS);
    });

    card.addEventListener("pointermove", (e) => {
      if (!held) return;
      lastClientY = e.clientY;
      paint(py(e.clientY) - startY);
    });
    card.addEventListener("pointerup", drop);
    card.addEventListener("pointercancel", reset);
  });
}

// Single FAB, replaced in place. (Previously each render appended another one,
// so a sync-triggered re-render stacked duplicate + buttons on top of each other.)
function addFab(hash, label) {
  removeFab();
  const f = el(`<button class="fab" id="fab" title="Add"><span>${label}</span></button>`);
  f.addEventListener("click", () => (location.hash = hash));
  document.body.appendChild(f);
}
function removeFab() {
  // both FABs — the filter one is only ever on Home, so every other screen
  // must clear it or it lingers over the wrong list
  ["fab", "fab-filter"].forEach((id) => {
    const existing = document.getElementById(id);
    if (existing) existing.remove();
  });
}

// Mirror of the + button on the opposite corner. Deliberately NOT accent
// coloured: + is the one primary action on this screen, and two orange circles
// would compete. Neutral surface + border reads as secondary.
function addFilterFab(all) {
  const n = filterCount();
  const f = el(`<button class="fab fab-filter" id="fab-filter"
      title="Filter coffees" aria-label="Filter coffees">
      <span class="fab-ico">${filterSvg}</span>
      ${n ? `<span class="fab-badge">${n}</span>` : ""}
    </button>`);
  f.addEventListener("click", () => openFilterSheet(all));
  document.body.appendChild(f);
}

// Filter sheet. Facets are built from the coffees you actually have, so you
// can never select a roaster or roast that would return nothing.
function openFilterSheet(all) {
  const roasters = [...new Set(all.map((c) => c.roaster).filter(Boolean))].sort();
  const roasts = ["light", "medium", "dark"].filter((r) => all.some((c) => c.roast === r));
  const procs = ["washed", "honey", "natural"].filter((x) => all.some((c) => c.process === x));
  const anyDecaf = all.some((c) => c.decaf);
  const anyStar = all.length > 0;

  const pill = (facet, value, label, on) =>
    `<button type="button" class="toggle-pill" data-facet="${facet}"
       data-value="${esc(value)}" aria-pressed="${on}">${esc(label)}</button>`;

  const group = (title, html) =>
    html ? `<div class="filter-group"><h4>${title}</h4><div class="filter-pills">${html}</div></div>` : "";

  const overlay = el(`
    <div class="lightbox" id="filter-sheet">
      <div class="lightbox-inner sheet filter-sheet">
        <div class="filter-head">
          <h3>Filter</h3>
          ${anyStar ? `<button type="button" id="filter-star" class="star-btn"
            aria-pressed="${starredOnly}"
            title="${starredOnly ? "Showing starred only" : "Show starred only"}"
            >${starSvg(starredOnly)}</button>` : ""}
        </div>
        ${group("Roast", roasts.map((r) => pill("roast", r, r, FILTERS.roast.includes(r))).join(""))}
        ${group("Process", procs.map((x) => pill("process", x, x, FILTERS.process.includes(x))).join(""))}
        ${group("Roaster", roasters.map((r) => pill("roaster", r, r, FILTERS.roaster.includes(r))).join(""))}
        ${group("Other", anyDecaf ? pill("decaf", "1", "Decaf", FILTERS.decaf) : "")}
        <div class="filter-actions">
          <button type="button" id="filter-clear" class="link-btn">Clear all</button>
          <button type="button" id="filter-done">Show <span id="filter-n"></span></button>
        </div>
      </div>
    </div>`);

  const sheet = overlay.querySelector(".filter-sheet");
  const nSpan = overlay.querySelector("#filter-n");
  const refresh = () => {
    const n = applyFilters(all).length;
    nSpan.textContent = n === all.length ? `all ${n}` : `${n} of ${all.length}`;
  };

  overlay.querySelectorAll(".toggle-pill").forEach((b) =>
    b.addEventListener("click", () => {
      const { facet, value } = b.dataset;
      const on = b.getAttribute("aria-pressed") !== "true";
      b.setAttribute("aria-pressed", String(on));
      if (facet === "starred") starredOnly = on;
      else if (facet === "decaf") FILTERS.decaf = on;
      else if (on) FILTERS[facet].push(value);
      else FILTERS[facet] = FILTERS[facet].filter((v) => v !== value);
      refresh();
    }));

  const star = overlay.querySelector("#filter-star");
  const paintStar = () => {
    if (!star) return;
    star.setAttribute("aria-pressed", String(starredOnly));
    star.innerHTML = starSvg(starredOnly);
    star.title = starredOnly ? "Showing starred only" : "Show starred only";
  };
  if (star) star.addEventListener("click", () => {
    starredOnly = !starredOnly; paintStar(); refresh();
  });

  overlay.querySelector("#filter-clear").addEventListener("click", () => {
    clearFilters();
    overlay.querySelectorAll(".toggle-pill").forEach((b) => b.setAttribute("aria-pressed", "false"));
    paintStar();
    refresh();
  });

  const close = () => { overlay.remove(); safeRoute(); };
  overlay.querySelector("#filter-done").addEventListener("click", close);
  // backdrop closes; taps inside the sheet must not
  sheet.addEventListener("click", (e) => e.stopPropagation());
  overlay.addEventListener("click", close);

  document.body.appendChild(overlay);
  refresh();
}

main();
