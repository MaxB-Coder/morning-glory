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
export async function importAll(data) {
  const db = await open();
  const t = db.transaction(["grinder", "coffee", "brew"], "readwrite");
  if (data.grinder) t.objectStore("grinder").put({ ...data.grinder, id: "grinder" });
  (data.coffees || []).forEach((c) => t.objectStore("coffee").put({ ...c, id: String(c.id) }));
  (data.brews || []).forEach((b) => t.objectStore("brew").put({ ...b, id: String(b.id) }));
  return new Promise((resolve, reject) => {
    t.oncomplete = resolve; t.onerror = () => reject(t.error);
  });
}
