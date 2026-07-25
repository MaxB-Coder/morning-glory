// Firebase sync layer. Offline-first: IndexedDB (db.js) stays the source of
// truth; this module mirrors dirty local records up to Firestore and merges
// remote changes back down (last-writer-wins by updatedAt).
//
// Loaded as an ES module. Firebase SDK is imported from the CDN by default;
// vendor it (see DEPLOY.md) for full offline. If firebase-config.js isn't
// filled in, initSync() no-ops and the app runs local-only.

import {
  getGrinder, allCoffees, allBrews, pending, markSynced, upsertFromRemote, uuid,
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
    if (user) await resolveHousehold();
    onChange(status());
    if (state.householdId) startSubscriptions();
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
function prefersRedirect() {
  const standalone = window.matchMedia("(display-mode: standalone)").matches
    || window.navigator.standalone === true;
  const mobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
  return standalone || mobile;
}

export async function signIn({ forceRedirect = false } = {}) {
  if (!fb) throw new Error("sync not initialized");
  const { signInWithPopup, signInWithRedirect } = fb.authMod;

  if (forceRedirect || prefersRedirect()) {
    await signInWithRedirect(fb.auth, fb.provider);   // navigates away; returns on load
    return;
  }
  try {
    await signInWithPopup(fb.auth, fb.provider);
  } catch (e) {
    // popup blocked / blank / closed — fall back to redirect
    const fallback = ["auth/popup-blocked", "auth/popup-closed-by-user",
                      "auth/cancelled-popup-request", "auth/operation-not-supported-in-this-environment"];
    if (fallback.includes(e.code)) {
      console.warn("[sync] popup failed (", e.code, ") → redirecting");
      await signInWithRedirect(fb.auth, fb.provider);
      return;
    }
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

function colPath(name) { return `households/${state.householdId}/${name}s`; }

function startSubscriptions() {
  if (!state.householdId || !fb) return;
  stopSubscriptions();
  const { collection, onSnapshot, doc } = fb.fs;

  for (const name of ["coffee", "brew"]) {
    const col = collection(fb.dbf, colPath(name));
    unsub.push(onSnapshot(col, async (snap) => {
      let changed = false;
      for (const d of snap.docChanges()) {
        const rec = { ...d.doc.data(), id: d.doc.id };
        if (await upsertFromRemote(name, rec)) changed = true;
      }
      if (changed) state.onData();
    }));
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

// Push all dirty local records up.
export async function flush() {
  if (!state.householdId || !fb || !state.online) return;
  const { doc, setDoc, updateDoc } = fb.fs;
  const dirty = await pending();

  for (const name of ["coffee", "brew"]) {
    for (const rec of dirty[name]) {
      const { dirty: _d, ...payload } = rec;
      payload.authorUid = state.user.uid;
      await setDoc(doc(fb.dbf, colPath(name), rec.id), payload, { merge: true });
      await markSynced(name, rec.id);
    }
  }
  if (dirty.grinder.length) {
    const { dirty: _d, id: _i, ...g } = dirty.grinder[0];
    await updateDoc(doc(fb.dbf, "households", state.householdId), { grinder: g });
    await markSynced("grinder", "grinder");
  }
}

// Seed a freshly-created household with existing local data.
async function pushAllLocal() {
  const { doc, setDoc, updateDoc } = fb.fs;
  const g = await getGrinder();
  if (g) { const { dirty, id, ...gg } = g;
    await updateDoc(doc(fb.dbf, "households", state.householdId), { grinder: gg }); }
  for (const c of await allCoffees()) {
    const { dirty, ...payload } = c; payload.authorUid = state.user.uid;
    await setDoc(doc(fb.dbf, colPath("coffee"), c.id), payload, { merge: true });
    await markSynced("coffee", c.id);
  }
  for (const b of await allBrews()) {
    const { dirty, ...payload } = b; payload.authorUid = state.user.uid;
    await setDoc(doc(fb.dbf, colPath("brew"), b.id), payload, { merge: true });
    await markSynced("brew", b.id);
  }
}
