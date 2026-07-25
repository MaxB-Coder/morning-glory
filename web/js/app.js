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
const view = document.getElementById("view");
const boot = document.getElementById("boot");
const bootStatus = document.getElementById("boot-status");

const el = (html) => { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstElementChild; };
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

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
  window.addEventListener("hashchange", route);
  try {
    showApp();
    await route();
  } catch (e) {
    console.error("[route]", e);
    view.innerHTML = `<article><strong>Something broke rendering the screen.</strong>
      <p><small>${esc(e.message || e)}</small></p></article>`;
  }

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
    onData: () => route(),
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
async function route() {
  const hash = location.hash || "#/";
  const [path, query] = hash.slice(1).split("?");
  const params = new URLSearchParams(query || "");
  const parts = path.split("/").filter(Boolean);

  document.querySelectorAll("[data-nav]").forEach((a) =>
    a.classList.toggle("active", a.getAttribute("href") === `#/${parts[0] || ""}`));

  // gate on setup
  const grinder = await db.getGrinder();
  if (!grinder && parts[0] !== "setup") { location.hash = "#/setup"; return; }

  if (parts[0] === "setup") return renderSetup();
  if (parts[0] === "coffee" && parts[1] === "new") return renderCoffeeForm();
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
  const coffees = await db.allCoffees();
  const list = coffees.length
    ? coffees.map((c) => `
        <article class="coffee-card" data-id="${c.id}">
          <strong>${esc(c.name)}</strong><br>
          <small>${c.roast} · ${c.process}${c.origin ? " · " + esc(c.origin) : ""}</small>
        </article>`).join("")
    : `<p><small>No coffees yet. Add your first bag.</small></p>`;
  view.replaceChildren(el(`<div><h2>Your coffees</h2>${list}</div>`));
  view.querySelectorAll(".coffee-card").forEach((c) =>
    c.addEventListener("click", () => (location.hash = `#/coffee/${c.dataset.id}`)));
  addFab("#/coffee/new", "+");
}

// --- coffee form ------------------------------------------------------------
function renderCoffeeForm() {
  view.replaceChildren(el(`
    <article>
      <h2>Register coffee</h2>
      <form id="coffee-form">
        <label>Name <input name="name" required placeholder="Roaster — Origin"></label>
        <div class="grid">
          <label>Roast
            <select name="roast"><option>light</option><option selected>medium</option><option>dark</option></select>
          </label>
          <label>Process
            <select name="process"><option selected>washed</option><option>honey</option><option>natural</option></select>
          </label>
        </div>
        <details>
          <summary>More detail (optional)</summary>
          <label>Roast date <input name="roastDate" type="date"></label>
          <label>Origin <input name="origin"></label>
          <label>Variety <input name="variety"></label>
          <label>Altitude (masl) <input name="altitudeMasl" type="number"></label>
          <label><input name="decaf" type="checkbox"> Decaf</label>
          <label>Notes <textarea name="notes"></textarea></label>
        </details>
        <button type="submit">Save coffee</button>
      </form>
    </article>`));
  view.querySelector("#coffee-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const c = await db.addCoffee({
      name: f.get("name"), roast: f.get("roast"), process: f.get("process"),
      roastDate: f.get("roastDate") || null, origin: f.get("origin") || null,
      variety: f.get("variety") || null,
      altitudeMasl: f.get("altitudeMasl") ? +f.get("altitudeMasl") : null,
      decaf: f.get("decaf") ? 1 : 0, notes: f.get("notes") || null,
    });
    location.hash = `#/coffee/${c.id}`;
  });
}

// --- coffee detail ----------------------------------------------------------
async function renderCoffee(id) {
  const c = await db.getCoffee(id);
  if (!c) { location.hash = "#/"; return; }
  const brews = (await db.brewsForCoffee(id)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const g = await db.getGrinder();

  const strip = brews.length ? `<div class="dial-strip">${brews.map((b) => {
    const h = Math.max(8, ((b.grindSetting - g.min) / (g.max - g.min)) * 100);
    return `<div class="dial-bar ${b.verdict}" style="height:${h}%" title="${b.method} ${b.grindSetting} (${b.verdict})"></div>`;
  }).join("")}</div>` : "";

  const rows = brews.slice().reverse().map((b) =>
    `<tr><td>${b.createdAt.slice(0, 10)}</td><td>${METHOD_LABEL[b.method]}</td><td>${b.grindSetting}</td><td>${verdictLabel(b.verdict)}</td></tr>`
  ).join("");

  view.replaceChildren(el(`
    <div>
      <h2>${esc(c.name)}</h2>
      <p><small>${c.roast} · ${c.process}${c.origin ? " · " + esc(c.origin) : ""}${c.decaf ? " · decaf" : ""}</small></p>
      <div class="method-pills">${METHODS.map((m) =>
        `<button data-m="${m}">${METHOD_LABEL[m]}</button>`).join("")}</div>
      <p><small>Dial-in history:</small></p>${strip || "<p><small>No brews logged yet.</small></p>"}
      ${brews.length ? `<table><thead><tr><th>Date</th><th>Method</th><th>Grind</th><th>Result</th></tr></thead><tbody>${rows}</tbody></table>` : ""}
    </div>`));
  view.querySelectorAll(".method-pills button").forEach((btn) =>
    btn.addEventListener("click", () => location.hash = `#/brew?coffee=${id}&method=${btn.dataset.m}`));
}

// --- brew (the core screen) -------------------------------------------------
async function renderBrew(coffeeId, method) {
  method = method || "espresso";
  const c = await db.getCoffee(coffeeId);
  const g = await db.getGrinder();
  if (!c) { location.hash = "#/"; return; }

  view.replaceChildren(el(`
    <div>
      <h2>${esc(c.name)}</h2>
      <div class="method-pills" id="pills">${METHODS.map((m) =>
        `<button data-m="${m}" ${m === method ? 'aria-current="true"' : ""}>${METHOD_LABEL[m]}</button>`).join("")}</div>
      <div class="rec-wrap" id="rec"><progress></progress></div>
      <label>Grind setting used
        <input id="grind" type="number" step="${g.step}" value="">
      </label>
      <details id="extras"></details>
      <div class="verdict-row">
        <button class="v-good" data-v="good">🟢 Good</button>
        <button class="v-under" data-v="under">🟠 Sour / weak</button>
        <button class="v-over" data-v="over">🔴 Bitter / harsh</button>
      </div>
    </div>`));

  renderExtras(method);

  const pills = view.querySelector("#pills");
  pills.querySelectorAll("button").forEach((b) =>
    b.addEventListener("click", () => location.hash = `#/brew?coffee=${coffeeId}&method=${b.dataset.m}`));

  // fetch recommendation from the Python engine
  const payload = {
    grinder: g,
    coffees: await db.allCoffees(),
    brews: await db.allBrews(),
    request: { coffeeId: Number(coffeeId), method },
  };
  let rec;
  try { rec = await recommend(payload); }
  catch (e) { console.error(e); rec = null; }

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
    recEl.innerHTML = `<p><small>Engine unavailable. Log your brew and the recommendation returns when the engine loads.</small></p>`;
  }

  view.querySelectorAll(".verdict-row button").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const grind = parseFloat(view.querySelector("#grind").value);
      if (isNaN(grind)) { view.querySelector("#grind").focus(); return; }
      const extra = collectExtras(method);
      await db.addBrew({ coffeeId: Number(coffeeId), method, grindSetting: grind, verdict: btn.dataset.v, ...extra });
      location.hash = `#/coffee/${coffeeId}`;
    }));
}

function renderExtras(method) {
  const d = view.querySelector("#extras");
  if (!d) return;
  if (method === "espresso") {
    d.innerHTML = `<summary>Shot detail (optional)</summary>
      <div class="grid">
        <label>Dose g <input id="doseG" type="number" step="any"></label>
        <label>Yield g <input id="yieldG" type="number" step="any"></label>
        <label>Time s <input id="shotTimeS" type="number" step="any"></label>
      </div>`;
  } else {
    d.innerHTML = `<summary>Brew detail (optional)</summary>
      <div class="grid">
        <label>Dose g <input id="doseG" type="number" step="any"></label>
        <label>Brew time s <input id="brewTimeS" type="number" step="any"></label>
        <label>Water °C <input id="waterTempC" type="number" step="any"></label>
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
  const coffees = Object.fromEntries((await db.allCoffees()).map((c) => [c.id, c]));
  const rows = brews.map((b) =>
    `<tr><td>${b.createdAt.slice(0, 10)}</td><td>${esc(coffees[b.coffeeId]?.name || "?")}</td><td>${METHOD_LABEL[b.method]}</td><td>${b.grindSetting}</td><td>${verdictLabel(b.verdict)}</td></tr>`
  ).join("");
  view.replaceChildren(el(`<div><h2>History</h2>${brews.length
    ? `<table><thead><tr><th>Date</th><th>Coffee</th><th>Method</th><th>Grind</th><th>Result</th></tr></thead><tbody>${rows}</tbody></table>`
    : "<p><small>No brews logged yet.</small></p>"}</div>`));
}

// --- settings ---------------------------------------------------------------
async function renderSettings() {
  const g = await db.getGrinder();
  view.replaceChildren(el(`
    <div>
      <h2>Settings</h2>
      <article>
        <strong>Grinder:</strong> ${esc(g.name)} (${g.min}–${g.max}, step ${g.step})
        ${g.calibration ? `· calibrated: ${METHOD_LABEL[g.calibration.method]} @ ${g.calibration.setting}` : ""}
        <br><a href="#/setup">Edit grinder</a>
      </article>
      <article id="sync-panel"><strong>Sharing</strong><p><small>Loading…</small></p></article>
      <article>
        <strong>Backup</strong>
        <p><small>IndexedDB can be cleared by the browser. Export a JSON backup regularly.</small></p>
        <button id="export">Export backup</button>
        <label>Import backup <input id="import" type="file" accept="application/json"></label>
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
    const data = JSON.parse(await file.text());
    await db.importAll(data);
    alert("Backup imported.");
    location.hash = "#/";
  });

  await renderSyncPanel();
}

async function renderSyncPanel() {
  const panel = document.getElementById("sync-panel");
  if (!panel) return;
  const st = sync.status();

  if (!st.available) {
    panel.innerHTML = `<strong>Sharing</strong>
      <p><small>Sync isn't configured. The app runs locally on this device.
      To share with someone, add your Firebase keys in
      <code>js/firebase-config.js</code> (see SYNC-DESIGN.md).</small></p>`;
    return;
  }

  if (!st.signedIn) {
    panel.innerHTML = `<strong>Sharing</strong>
      <p><small>Sign in to sync your coffees and brews across devices and share
      with someone.</small></p>
      <button id="signin">Sign in with Google</button>
      <p><a href="#" id="signin-redirect"><small>Trouble signing in? Use redirect instead</small></a></p>
      <p id="auth-err" class="explain"></p>`;
    const errBox = panel.querySelector("#auth-err");
    if (sync.lastAuthError()) errBox.textContent = "Last error: " + sync.lastAuthError();
    const go = (opts) => sync.signIn(opts).catch((e) => {
      console.error("[signin]", e);
      errBox.textContent = "Sign-in failed: " + (e.code || e.message);
    });
    panel.querySelector("#signin").addEventListener("click", () => go({}));
    panel.querySelector("#signin-redirect").addEventListener("click", (ev) => {
      ev.preventDefault(); go({ forceRedirect: true });
    });
    return;
  }

  if (!st.householdId) {
    panel.innerHTML = `<strong>Sharing</strong>
      <p><small>Signed in as ${esc(st.user.name || st.user.email)}.</small></p>
      <p><small>Create a household (then share the code) or join one.</small></p>
      <button id="create">Create household</button>
      <label>Join with invite code
        <input id="joincode" placeholder="6-char code" maxlength="6" style="text-transform:uppercase">
      </label>
      <button id="join" class="secondary">Join</button>
      <p><a href="#" id="signout"><small>Sign out</small></a></p>`;
    panel.querySelector("#create").addEventListener("click", async () => {
      try { const code = await sync.createHousehold();
        alert("Household created. Invite code: " + code); renderSettings(); }
      catch (e) { alert("Failed: " + e.message); }
    });
    panel.querySelector("#join").addEventListener("click", async () => {
      const code = panel.querySelector("#joincode").value;
      try { await sync.joinHousehold(code); alert("Joined!"); renderSettings(); }
      catch (e) { alert("Join failed: " + e.message); }
    });
    panel.querySelector("#signout").addEventListener("click", async (ev) => {
      ev.preventDefault(); await sync.signOutUser(); renderSettings();
    });
    return;
  }

  const code = await sync.getInviteCode();
  panel.innerHTML = `<strong>Sharing</strong>
    <p><small>Signed in as ${esc(st.user.name || st.user.email)} · sync ${st.online ? "on" : "offline"}.</small></p>
    <p>Invite code: <strong style="font-size:1.3rem;letter-spacing:.15em">${esc(code || "—")}</strong></p>
    <p><small>Share this code with the person you want to sync with. They sign in and tap Join.</small></p>
    <p><a href="#" id="signout"><small>Sign out</small></a></p>`;
  panel.querySelector("#signout").addEventListener("click", async (ev) => {
    ev.preventDefault(); await sync.signOutUser(); renderSettings();
  });
}

// --- helpers ----------------------------------------------------------------
function verdictLabel(v) { return { good: "🟢 Good", under: "🟠 Sour", over: "🔴 Bitter" }[v] || v; }
function addFab(hash, label) {
  const f = el(`<button class="fab" title="Add">${label}</button>`);
  f.addEventListener("click", () => (location.hash = hash));
  document.body.appendChild(f);
  const clean = () => { f.remove(); window.removeEventListener("hashchange", clean); };
  window.addEventListener("hashchange", clean);
}

main();
