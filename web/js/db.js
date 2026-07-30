// IndexedDB wrapper — local source of truth. The ONLY place that touches raw
// IndexedDB. Sync-ready: every coffee/brew carries a string UUID `id`, an
// `updatedAt` (ms epoch), a `dirty` flag (needs upload), and soft-delete via
// `deleted:true` tombstones. The sync layer (sync.js) reads/writes through the
// helpers at the bottom; the engine + UI use the same records they always did.

const DB_NAME = "morningglory";
const DB_VERSION = 2;              // bumped from 1: string keys + sync fields
let _db = null;

export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}
const now = () => Date.now();

function open() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      // v2 uses string keyPath ids (client UUIDs) so offline-created records
      // keep a stable id when they sync. Fresh install => just create stores.
      if (db.objectStoreNames.contains("coffee")) db.deleteObjectStore("coffee");
      if (db.objectStoreNames.contains("brew")) db.deleteObjectStore("brew");
      if (!db.objectStoreNames.contains("grinder")) {
        db.createObjectStore("grinder", { keyPath: "id" });
      }
      const coffee = db.createObjectStore("coffee", { keyPath: "id" });
      coffee.createIndex("dirty", "dirty");
      const brew = db.createObjectStore("brew", { keyPath: "id" });
      brew.createIndex("byCoffee", "coffeeId");
      brew.createIndex("dirty", "dirty");
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

function p(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function store(name, mode = "readonly") {
  const db = await open();
  return db.transaction(name, mode).objectStore(name);
}

// --- grinder (singleton id="grinder") --------------------------------------
export async function getGrinder() {
  const g = await p((await store("grinder")).get("grinder"));
  return g && !g.deleted ? g : null;
}
export async function saveGrinder(g) {
  const rec = { ...g, id: "grinder", updatedAt: now(), dirty: 1, deleted: false };
  await p((await store("grinder", "readwrite")).put(rec));
  return rec;
}

// --- coffee ----------------------------------------------------------------
export async function addCoffee(c) {
  const rec = {
    ...c, id: c.id || uuid(), createdAt: c.createdAt || new Date().toISOString(),
    archived: c.archived ? 1 : 0,
    // "shared" lives in the household and syncs to everyone; "private" lives
    // under the owner's own user document and never leaves their devices.
    visibility: c.visibility === "private" ? "private" : "shared",
    starred: c.starred ? 1 : 0,
    roaster: c.roaster || null,
    updatedAt: now(), dirty: 1, deleted: false,
  };
  await p((await store("coffee", "readwrite")).add(rec));
  return rec;
}
export async function updateCoffee(c) {
  const rec = { ...c, updatedAt: now(), dirty: 1 };
  await p((await store("coffee", "readwrite")).put(rec));
  return rec;
}
export async function getCoffee(id) {
  const c = await p((await store("coffee")).get(String(id)));
  return c && !c.deleted ? c : null;
}
export async function allCoffees() {
  const all = await p((await store("coffee")).getAll());
  return all.filter((c) => !c.deleted && !c.archived);
}
// Archived coffees are hidden from the list but their brews still appear in
// history — so history needs to resolve their names too.
export async function allCoffeesIncludingArchived() {
  const all = await p((await store("coffee")).getAll());
  return all.filter((c) => !c.deleted);
}

// One-time migration. Before roaster was its own field the convention was to
// type "Songbird - Kin" into the name box (that was literally the placeholder),
// so split on the LAST " - " and move the tail into roaster. Only touches
// records where roaster has never been set; everything else gets roaster:null
// so it is never reconsidered. Marked dirty, so the split syncs to the other
// device rather than each phone splitting its own copy differently.
export async function migrateRoaster() {
  const os = await store("coffee", "readwrite");
  const all = await p(os.getAll());
  const recs = [];
  for (const c of all) {
    if (c.roaster !== undefined) continue;
    const [name, roaster] = splitNameRoaster(c.name);
    c.name = name; c.roaster = roaster;
    c.updatedAt = now(); c.dirty = 1;
    recs.push(c);
  }
  // Collect first, write second: issuing put() after awaiting a previous put
  // can land outside the transaction's active window, which throws
  // TransactionInactiveError and aborts the whole migration silently.
  for (const c of recs) await p(os.put(c));
  return recs.length;
}

// Accepts every separator that shows up in real bag names: hyphen, en dash,
// em dash, slash, and "by". Requires surrounding spaces so hyphenated names
// ("Kii AA-2", "Yirgacheffe-Kochere") are left intact. Splits on the LAST
// separator, since the coffee name is likelier to contain one than the roaster.
export function splitNameRoaster(raw) {
  const full = String(raw || "").trim();
  const m = [...full.matchAll(/\s+(?:[-\u2010-\u2015\u2212/|]|by)\s+/gi)].pop();
  if (!m) return [full, null];
  const name = full.slice(0, m.index).trim();
  const roaster = full.slice(m.index + m[0].length).trim();
  if (!name || !roaster) return [full, null];
  return [name, roaster.slice(0, 80)];
}

// --- brew ------------------------------------------------------------------
export async function addBrew(b) {
  const rec = {
    ...b, id: b.id || uuid(), createdAt: b.createdAt || new Date().toISOString(),
    updatedAt: now(), dirty: 1, deleted: false,
  };
  await p((await store("brew", "readwrite")).add(rec));
  return rec;
}
export async function allBrews() {
  const all = await p((await store("brew")).getAll());
  return all.filter((b) => !b.deleted);
}
export async function brewsForCoffee(coffeeId) {
  const idx = (await store("brew")).index("byCoffee");
  const all = await p(idx.getAll(String(coffeeId)));
  return all.filter((b) => !b.deleted);
}

// --- sync plumbing ----------------------------------------------------------
// Records needing upload (dirty === 1) across coffee + brew + grinder.
export async function pending() {
  const out = { coffee: [], brew: [], grinder: [] };
  for (const name of ["coffee", "brew"]) {
    const idx = (await store(name)).index("dirty");
    out[name] = await p(idx.getAll(1));
  }
  const g = await p((await store("grinder")).get("grinder"));
  if (g && g.dirty) out.grinder = [g];
  return out;
}
export async function markSynced(name, id) {
  const os = await store(name, "readwrite");
  const rec = await p(os.get(String(id)));
  if (rec) { rec.dirty = 0; await p(os.put(rec)); }
}
// Apply a record pulled from Firestore. Last-writer-wins: only overwrite if the
// remote is newer than what we have locally. Remote records arrive with
// dirty:0 (already in the cloud).
export async function upsertFromRemote(name, remote) {
  const os = await store(name, "readwrite");
  const key = name === "grinder" ? "grinder" : String(remote.id);
  const local = await p(os.get(key));
  if (local && (local.updatedAt || 0) > (remote.updatedAt || 0)) return false;
  await p(os.put({ ...remote, id: key, dirty: 0 }));
  return true;
}
// Remove a record locally WITHOUT leaving a tombstone. Used when the server
// says a doc is gone (e.g. someone made their coffee private, so it must
// vanish from everyone else's device rather than sync back as a deletion).
export async function hardDelete(name, id) {
  const os = await store(name, "readwrite");
  await p(os.delete(String(id)));
}

// Soft delete → tombstone that syncs.
export async function softDelete(name, id) {
  const os = await store(name, "readwrite");
  const rec = await p(os.get(String(id)));
  if (rec) { rec.deleted = true; rec.updatedAt = now(); rec.dirty = 1; await p(os.put(rec)); }
}

// --- backup (export/import) -------------------------------------------------
export async function exportAll() {
  return {
    version: 2, exportedAt: new Date().toISOString(),
    grinder: await p((await store("grinder")).get("grinder")),
    coffees: await p((await store("coffee")).getAll()),
    brews: await p((await store("brew")).getAll()),
  };
}
// --- import validation ------------------------------------------------------
// A backup file is UNTRUSTED input: it can be hand-edited, corrupted, or come
// from someone else. Previously whatever it contained went straight into
// IndexedDB and from there into the DOM. Everything is now whitelisted by
// field, coerced to the right type, and anything unexpected is dropped.

const METHODS = ["espresso", "moka", "aeropress", "v60", "chemex", "frenchpress", "coldbrew"];
const ROASTS = ["light", "medium", "dark"];
const PROCESSES = ["washed", "honey", "natural"];
const VERDICTS = ["good", "under", "over", "gusher", "choked"];
const IMG_RE = /^data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=]+$/;

const str = (v, max = 200) =>
  typeof v === "string" ? v.slice(0, max) : (v == null ? null : String(v).slice(0, max));
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const oneOf = (v, list, fallback) => (list.includes(v) ? v : fallback);

function cleanCoffee(raw) {
  if (!raw || typeof raw !== "object" || raw.id == null) return null;
  const name = str(raw.name, 120);
  if (!name) return null;
  return {
    id: String(raw.id).slice(0, 64),
    name,
    roast: oneOf(raw.roast, ROASTS, "medium"),
    process: oneOf(raw.process, PROCESSES, "washed"),
    roastDate: /^\d{4}-\d{2}-\d{2}/.test(String(raw.roastDate || "")) ? String(raw.roastDate).slice(0, 10) : null,
    roaster: str(raw.roaster, 80),
    origin: str(raw.origin, 80),
    variety: str(raw.variety, 80),
    altitudeMasl: num(raw.altitudeMasl),
    decaf: raw.decaf ? 1 : 0,
    notes: str(raw.notes, 2000),
    photo: typeof raw.photo === "string" && IMG_RE.test(raw.photo) ? raw.photo : null,
    visibility: raw.visibility === "private" ? "private" : "shared",
    starred: raw.starred ? 1 : 0,
    archived: raw.archived ? 1 : 0,
    createdAt: str(raw.createdAt, 40) || new Date().toISOString(),
    updatedAt: num(raw.updatedAt) || now(),
    deleted: !!raw.deleted,
    dirty: 1,
  };
}

function cleanBrew(raw) {
  if (!raw || typeof raw !== "object" || raw.id == null || raw.coffeeId == null) return null;
  const grind = num(raw.grindSetting);
  if (grind == null) return null;
  const out = {
    id: String(raw.id).slice(0, 64),
    coffeeId: String(raw.coffeeId).slice(0, 64),
    method: oneOf(raw.method, METHODS, "espresso"),
    grindSetting: grind,
    verdict: oneOf(raw.verdict, VERDICTS, "good"),
    createdAt: str(raw.createdAt, 40) || new Date().toISOString(),
    updatedAt: num(raw.updatedAt) || now(),
    deleted: !!raw.deleted,
    dirty: 1,
  };
  for (const k of ["doseG", "yieldG", "shotTimeS", "brewTimeS", "waterTempC"]) {
    const v = num(raw[k]);
    if (v != null) out[k] = v;
  }
  return out;
}

function cleanGrinder(raw) {
  if (!raw || typeof raw !== "object") return null;
  const min = num(raw.min), max = num(raw.max), step = num(raw.step);
  if (min == null || max == null || max <= min) return null;
  let calibration = null;
  if (raw.calibration && METHODS.includes(raw.calibration.method)) {
    const s = num(raw.calibration.setting);
    if (s != null) calibration = { method: raw.calibration.method, setting: s };
  }
  return {
    id: "grinder",
    name: str(raw.name, 80) || "Grinder",
    min, max, step: step && step > 0 ? step : 0.5,
    calibration,
    updatedAt: num(raw.updatedAt) || now(),
    deleted: false, dirty: 1,
  };
}

export async function importAll(data) {
  if (!data || typeof data !== "object") throw new Error("not a backup file");

  const grinder = cleanGrinder(data.grinder);
  const coffees = (Array.isArray(data.coffees) ? data.coffees : []).map(cleanCoffee).filter(Boolean);
  const brews = (Array.isArray(data.brews) ? data.brews : []).map(cleanBrew).filter(Boolean);

  // drop brews whose coffee isn't in the file — they'd be unreachable orphans
  const ids = new Set(coffees.map((c) => c.id));
  const usable = brews.filter((b) => ids.has(b.coffeeId));

  if (!grinder && !coffees.length) throw new Error("nothing importable in that file");

  const dbi = await open();
  const t = dbi.transaction(["grinder", "coffee", "brew"], "readwrite");
  if (grinder) t.objectStore("grinder").put(grinder);
  coffees.forEach((c) => t.objectStore("coffee").put(c));
  usable.forEach((b) => t.objectStore("brew").put(b));

  await new Promise((resolve, reject) => {
    t.oncomplete = resolve; t.onerror = () => reject(t.error);
  });
  return {
    coffees: coffees.length,
    brews: usable.length,
    skipped: (data.coffees?.length || 0) - coffees.length
           + (data.brews?.length || 0) - usable.length,
  };
}
