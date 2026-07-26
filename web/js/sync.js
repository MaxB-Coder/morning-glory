// Firebase sync layer. Offline-first: IndexedDB (db.js) stays the source of
// truth; this module mirrors dirty local records up to Firestore and merges
// remote changes back down (last-writer-wins by updatedAt).
//
// Loaded as an ES module. Firebase SDK is imported from the CDN by default;
// vendor it (see DEPLOY.md) for full offline. If firebase-config.js isn't
// filled in, initSync() no-ops and the app runs local-only.

import {
  getGrinder, allCoffees, allCoffeesIncludingArchived, allBrews, brewsForCoffee,
  getCoffee, updateCoffee, pending, markSynced, upsertFromRemote, hardDelete, uuid,
} from "./db.js";
import { firebaseConfig, isConfigured } from "./firebase-config.js";

const SDK = "https://www.gstatic.com/firebasejs/10.12.0";

let fb = null;          // { app, auth, dbf, providers... }
let state = {
  user: null, householdId: null, online: navigator.onLine,
  onChange: () => {}, onData: () => {},
};

// ---- lifecycle -------------------------------------------------------------
export function isSyncAvailable() { return isConfigured(); }
export function lastAuthError() { return state.lastAuthError || null; }
export function currentUser() { return state.user; }
export function householdId() { return state.householdId; }

export async function initSync({ onChange = () => {}, onData = () => {} } = {}) {
  state.onChange = onChange;
  state.onData = onData;
  if (!isConfigured()) { onChange(status()); return; }

  const [{ initializeApp }, auth, fs] = await Promise.all([
    import(`${SDK}/firebase-app.js`),
    import(`${SDK}/firebase-auth.js`),
    import(`${SDK}/firebase-firestore.js`),
  ]);
  const app = initializeApp(firebaseConfig);
  // offline persistence so Firestore itself queues writes when offline
  const dbf = fs.initializeFirestore(app, {});
  try { await fs.enableIndexedDbPersistence(dbf); } catch (_) { /* multi-tab ok */ }

  const authInstance = auth.getAuth(app);
  fb = { app, fs, authMod: auth, dbf, auth: authInstance,
         provider: new auth.GoogleAuthProvider() };

  window.addEventListener("online", () => { state.online = true; onChange(status()); flush(); });
  window.addEventListener("offline", () => { state.online = false; onChange(status()); });

  // Complete a redirect sign-in if we're coming back from Google.
  try {
    const res = await auth.getRedirectResult(authInstance);
    if (res && res.user) console.info("[sync] redirect sign-in complete");
  } catch (e) {
    console.error("[sync] redirect result error", e.code || e.message);
    state.lastAuthError = e.code || e.message;
  }

  auth.onAuthStateChanged(authInstance, async (user) => {
    state.user = user ? { uid: user.uid, name: user.displayName, email: user.email } : null;
    // Tell the UI we're signed in FIRST — a failing household lookup (offline,
    // rules, missing doc) must not prevent the signed-in state from showing.
    onChange(status());
    if (user) {
      try {
        await resolveHousehold();
      } catch (e) {
        console.error("[sync] household lookup failed", e.code || e.message);
        state.lastAuthError = "household lookup: " + (e.code || e.message);
      }
      onChange(status());
      if (state.householdId) startSubscriptions();
    }
  });
}

export function status() {
  return {
    available: isConfigured(),
    signedIn: !!state.user,
    user: state.user,
    householdId: state.householdId,
    online: state.online,
  };
}

// ---- auth ------------------------------------------------------------------
// Installed PWAs (iOS especially) and some mobile browsers can't open the popup
// window — it appears blank or is blocked. Redirect works everywhere, so use it
// on standalone/mobile and keep the popup for desktop browsers where it's nicer.
// Redirect is the default for EVERY platform. Popup sign-in is fragile:
// installed PWAs on iOS can't open it, and Chrome's Cross-Origin-Opener-Policy
// can close the popup without ever resolving the promise (the "opens then
// closes and nothing happens" symptom). Redirect has none of those failure
// modes; the only cost is a page navigation, and getRedirectResult() in
// initSync() picks the session back up on return.
// Popup first (it keeps you on the page and works well on desktop), with an
// automatic redirect fallback for environments that can't open one — notably
// installed PWAs on iOS, where popups are blocked outright.
export async function signIn({ useRedirect = false } = {}) {
  if (!fb) throw new Error("sync not initialized");
  const { signInWithPopup, signInWithRedirect } = fb.authMod;

  if (useRedirect) {
    await signInWithRedirect(fb.auth, fb.provider);
    return;
  }
  try {
    await signInWithPopup(fb.auth, fb.provider);
  } catch (e) {
    const code = e.code || "";
    const cannotPopup = [
      "auth/popup-blocked",
      "auth/operation-not-supported-in-this-environment",
      "auth/web-storage-unsupported",
    ].includes(code);
    if (cannotPopup) {
      console.warn("[sync] popup unavailable (", code, ") → redirecting");
      await signInWithRedirect(fb.auth, fb.provider);
      return;
    }
    // popup-closed-by-user / cancelled: user's choice, don't hijack the page
    throw e;
  }
}
export async function signOutUser() {
  if (!fb) return;
  await fb.authMod.signOut(fb.auth);
  state.householdId = null;
}

// ---- household -------------------------------------------------------------
async function resolveHousehold() {
  const { doc, getDoc } = fb.fs;
  const uref = doc(fb.dbf, "users", state.user.uid);
  const snap = await getDoc(uref);
  state.householdId = snap.exists() ? (snap.data().householdId || null) : null;
}

function makeCode() {
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous chars
  return Array.from({ length: 6 }, () => abc[(Math.random() * abc.length) | 0]).join("");
}

export async function createHousehold(name = "Our coffee") {
  const { doc, setDoc, serverTimestamp } = fb.fs;
  const hid = uuid();
  const code = makeCode();
  const uid = state.user.uid;
  await setDoc(doc(fb.dbf, "households", hid), {
    name,
    memberUids: [uid],
    members: { [uid]: { role: "owner", displayName: state.user.name || "" } },
    inviteCode: code,
    createdAt: serverTimestamp(),
  });
  // public lookup so a joiner can resolve code -> hid without reading household
  await setDoc(doc(fb.dbf, "invites", code), { householdId: hid });
  await setDoc(doc(fb.dbf, "users", uid), {
    householdId: hid, displayName: state.user.name || "", email: state.user.email || "",
  });
  state.householdId = hid;
  await pushAllLocal();          // seed the household with what you already have
  startSubscriptions();
  state.onChange(status());
  return code;
}

export async function joinHousehold(code) {
  const { doc, getDoc, setDoc, updateDoc, arrayUnion } = fb.fs;
  code = (code || "").trim().toUpperCase();
  const inv = await getDoc(doc(fb.dbf, "invites", code));
  if (!inv.exists()) throw new Error("Invalid invite code");
  const hid = inv.data().householdId;
  const uid = state.user.uid;
  // rules allow a signed-in user to add ONLY their own uid to memberUids
  await updateDoc(doc(fb.dbf, "households", hid), {
    memberUids: arrayUnion(uid),
    [`members.${uid}`]: { role: "member", displayName: state.user.name || "" },
  });
  await setDoc(doc(fb.dbf, "users", uid), {
    householdId: hid, displayName: state.user.name || "", email: state.user.email || "",
  });
  state.householdId = hid;
  startSubscriptions();
  state.onChange(status());
}

export async function getInviteCode() {
  if (!state.householdId) return null;
  const { doc, getDoc } = fb.fs;
  const snap = await getDoc(doc(fb.dbf, "households", state.householdId));
  return snap.exists() ? snap.data().inviteCode : null;
}

// ---- data sync -------------------------------------------------------------
let unsub = [];

// Shared data lives under the household; private data under the signed-in
// user. Which path a record uses is decided purely by its coffee's visibility.
function colPath(name) { return `households/${state.householdId}/${name}s`; }
function privPath(name) { return `users/${state.user.uid}/${name}s`; }

function startSubscriptions() {
  if (!state.householdId || !fb) return;
  stopSubscriptions();
  const { collection, onSnapshot, doc } = fb.fs;

  // Watch BOTH the shared household collections and this user's private ones.
  const watch = (name, path) => {
    const col = collection(fb.dbf, path);
    unsub.push(onSnapshot(col, async (snap) => {
      let changed = false;
      for (const d of snap.docChanges()) {
        if (d.type === "removed") {
          // Gone from the server — e.g. the owner made it private. Drop it
          // locally without a tombstone, or we'd sync the deletion back.
          await hardDelete(name, d.doc.id);
          changed = true;
          continue;
        }
        const rec = { ...d.doc.data(), id: d.doc.id };
        if (await upsertFromRemote(name, rec)) changed = true;
      }
      if (changed) state.onData();
    }));
  };

  for (const name of ["coffee", "brew"]) {
    watch(name, colPath(name));
    watch(name, privPath(name));
  }
  // shared grinder is a single doc on the household
  const hdoc = doc(fb.dbf, "households", state.householdId);
  unsub.push(onSnapshot(hdoc, async (snap) => {
    const g = snap.data() && snap.data().grinder;
    if (g && await upsertFromRemote("grinder", { ...g, id: "grinder" })) state.onData();
  }));

  flush(); // push anything queued
}
function stopSubscriptions() { unsub.forEach((u) => u && u()); unsub = []; }

// Is this coffee private? Brews inherit the visibility of their coffee, so a
// private bag's brews never reach the household either.
async function isPrivateCoffee(coffeeId) {
  const c = await getCoffee(coffeeId);
  return !!c && c.visibility === "private";
}

// Push all dirty local records up, each to the right path.
export async function flush() {
  if (!state.householdId || !fb || !state.online) return;
  const { doc, setDoc, updateDoc } = fb.fs;
  const dirty = await pending();

  for (const name of ["coffee", "brew"]) {
    for (const rec of dirty[name]) {
      const { dirty: _d, ...payload } = rec;
      payload.authorUid = state.user.uid;
      const priv = name === "coffee"
        ? rec.visibility === "private"
        : await isPrivateCoffee(rec.coffeeId);
      const path = priv ? privPath(name) : colPath(name);
      await setDoc(doc(fb.dbf, path, rec.id), payload, { merge: true });
      await markSynced(name, rec.id);
    }
  }
  if (dirty.grinder.length) {
    const { dirty: _d, id: _i, ...g } = dirty.grinder[0];
    await updateDoc(doc(fb.dbf, "households", state.householdId), { grinder: g });
    await markSynced("grinder", "grinder");
  }
}

/**
 * Move a coffee (and all of its brews) between the shared household and this
 * user's private space.
 *
 * Making a coffee PRIVATE deletes it and its brews from the household, so it
 * disappears from the other person's device and stops training their engine —
 * which is the whole point of marking it private.
 *
 * Works offline too: the local record is updated immediately and the remote
 * move happens on the next flush; the destination write is what matters, and
 * the source delete is retried by Firestore's own offline queue.
 */
export async function setCoffeeVisibility(coffeeId, visibility) {
  const coffee = await getCoffee(coffeeId);
  if (!coffee) throw new Error("coffee not found");
  const priv = visibility === "private";

  // 1. local first, so the UI is correct even with no connection
  await updateCoffee({ ...coffee, visibility: priv ? "private" : "shared" });
  const brews = await brewsForCoffee(coffeeId);

  if (!fb || !state.householdId || !state.online) return;

  const { doc, setDoc, deleteDoc } = fb.fs;
  const from = (name) => (priv ? colPath(name) : privPath(name));
  const to = (name) => (priv ? privPath(name) : colPath(name));

  // 2. write to the destination
  const payload = { ...coffee, visibility: priv ? "private" : "shared",
                    authorUid: state.user.uid };
  delete payload.dirty;
  await setDoc(doc(fb.dbf, to("coffee"), coffeeId), payload, { merge: true });
  for (const b of brews) {
    const { dirty, ...bp } = b;
    bp.authorUid = state.user.uid;
    await setDoc(doc(fb.dbf, to("brew"), b.id), bp, { merge: true });
  }

  // 3. remove from the source — this is what makes it actually disappear
  //    for the other person (their onSnapshot fires a "removed" change).
  for (const b of brews) {
    await deleteDoc(doc(fb.dbf, from("brew"), b.id)).catch(() => {});
  }
  await deleteDoc(doc(fb.dbf, from("coffee"), coffeeId)).catch(() => {});

  await markSynced("coffee", coffeeId);
  for (const b of brews) await markSynced("brew", b.id);
}

// Seed a freshly-created household with existing local data.
async function pushAllLocal() {
  const { doc, setDoc, updateDoc } = fb.fs;
  const g = await getGrinder();
  if (g) { const { dirty, id, ...gg } = g;
    await updateDoc(doc(fb.dbf, "households", state.householdId), { grinder: gg }); }
  // respect visibility while seeding: private bags go to the user's own space
  const coffees = await allCoffeesIncludingArchived();
  const privIds = new Set(coffees.filter((c) => c.visibility === "private").map((c) => String(c.id)));
  for (const c of coffees) {
    const { dirty, ...payload } = c; payload.authorUid = state.user.uid;
    const path = privIds.has(String(c.id)) ? privPath("coffee") : colPath("coffee");
    await setDoc(doc(fb.dbf, path, c.id), payload, { merge: true });
    await markSynced("coffee", c.id);
  }
  for (const b of await allBrews()) {
    const { dirty, ...payload } = b; payload.authorUid = state.user.uid;
    const path = privIds.has(String(b.coffeeId)) ? privPath("brew") : colPath("brew");
    await setDoc(doc(fb.dbf, path, b.id), payload, { merge: true });
    await markSynced("brew", b.id);
  }
}
