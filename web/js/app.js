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
export const APP_VERSION = "1.4.6";

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
    (!starredOnly || c.starred)
    && (!FILTERS.decaf || c.decaf)
    && (!FILTERS.roast.length || FILTERS.roast.includes(c.roast))
    && (!FILTERS.process.length || FILTERS.process.includes(c.process))
    && (!FILTERS.roaster.length || FILTERS.roaster.includes(c.roaster || "")));
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
  const badge = document.getElementById("engine-badge");

  // Reveal the UI immediately. Coffee registration / setup work without the
  // engine; only the recommendation number needs Pyodide. Don't block on it.
  // Every navigation goes through safeRoute, not route: previously only the
  // FIRST render was wrapped, so a later failure left a blank screen with the
  // error only in a console you can't open on a phone.
  window.addEventListener("hashchange", safeRoute);
  showApp();
  await safeRoute();

  // Warm the engine in the background; update the badge when done.
  initEngine((s) => { badge.textContent = "engine: " + s.toLowerCase(); })
    .then(() => { badge.textContent = "engine: ready"; badge.classList.add("ok"); })
    .catch((e) => {
      console.error("[engine]", e);
      badge.textContent = "engine: offline";
    });

  // Start sync in the background (no-op if Firebase isn't configured).
  // When remote data merges in, re-render the current screen.
  sync.initSync({
    onChange: (st) => {
      renderSyncBadge(st);
      // If the Sharing panel is on screen, re-render it so sign-in / household
      // state appears immediately instead of after a manual navigation.
      if (document.getElementById("sync-panel")) renderSyncPanel();
    },
    onData: () => safeRoute(),
  }).catch((e) => console.warn("[sync]", e));
}

function renderSyncBadge(st) {
  const b = document.getElementById("sync-badge");
  if (!b) return;
  if (!st.available) { b.hidden = true; return; }
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
  const all = await db.allCoffees();
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
          ${c.starred ? `<span class="star-mark">${starSvg(true)}</span>` : ""}
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
    c.addEventListener("click", () => (location.hash = `#/coffee/${c.dataset.id}`)));
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
                aria-pressed="${c.starred ? "true" : "false"}"
                title="${c.starred ? "Starred" : "Star this coffee"}"
          >${starSvg(!!c.starred)}</button>
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

  // star toggle — optimistic: flip the glyph immediately, then persist
  const star = view.querySelector("#star-toggle");
  star.addEventListener("click", async () => {
    const nowStarred = !c.starred;
    star.innerHTML = starSvg(nowStarred);
    star.setAttribute("aria-pressed", String(nowStarred));
    await db.updateCoffee({ ...c, starred: nowStarred ? 1 : 0 });
    c.starred = nowStarred ? 1 : 0;
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
          <small class="explain">${g.min}–${g.max} on your ${esc(g.name)}</small>
        </label>
        <details id="extras"></details>
      </section>

      <section class="step">
        <h3 class="step-title"><span class="step-num">3</span> How did it taste?</h3>
        <p><small>Tap one — this trains the recommendation.</small></p>
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
    const exp = (rec.explanation || []).map((x) =>
      `${x.label} ${x.delta > 0 ? "+" : ""}${x.delta}`).join(" · ");
    recEl.replaceChildren(el(`
      <div>
        <div class="rec-number">${rec.setting}</div>
        <div class="conf ${rec.confidence}">${rec.confidence} confidence</div>
        ${rec.nudge ? `<div class="nudge">${esc(rec.nudge)}</div>` : ""}
        ${exp ? `<details><summary class="explain">why?</summary><p class="explain">${esc(exp)}</p></details>` : ""}
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
      </div>
      ${dose ? '<p class="explain">Dose carried over from your last shot.</p>' : ""}`;
  } else {
    d.innerHTML = `<summary>Brew detail (optional)</summary>
      <div class="grid">
        <label>Dose (g) <input id="doseG" type="number" step="any" inputmode="decimal"${dose}></label>
        <label>Time (s) <input id="brewTimeS" type="number" step="any" inputmode="decimal"></label>
        <label>Water (°C) <input id="waterTempC" type="number" step="any" inputmode="decimal"${temp}></label>
      </div>
      ${dose || temp ? '<p class="explain">Carried over from your last brew.</p>' : ""}`;
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
      <h2>Settings</h2>
      <article>
        <div><strong>Grinder:</strong> ${esc(g.name)} (${g.min}–${g.max}, step ${g.step})</div>
        ${g.calibration
          ? `<div><strong>Calibrated:</strong> ${METHOD_LABEL[g.calibration.method]} @ ${g.calibration.setting}</div>`
          : `<div><small>Not calibrated</small></div>`}
        <div class="center-link" style="margin-top:.5rem"><a href="#/setup">Edit grinder</a></div>
      </article>
      <article id="sync-panel"><strong>Sharing</strong><p><small>Loading…</small></p></article>
      <article class="inline-row">
        <span>
          <strong>Version</strong> ${APP_VERSION}
          <br><small id="update-status">Checking for updates…</small>
        </span>
        <button id="force-update" class="secondary compact-btn" hidden>Update</button>
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
      <small class="who">${esc(st.user.name || st.user.email)} · sync ${st.online ? "on" : "offline"}</small>
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
  const anyStar = all.some((c) => c.starred);

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
