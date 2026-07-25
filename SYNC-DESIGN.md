# Morning Glory — Multi-user sync design (Firebase)

Adds shared, real-time-ish sync for two people while keeping the app
offline-first. Chosen: **Firebase Auth (Google) + Cloud Firestore**, separate
accounts joining a **household** by invite code, **all data shared**,
**offline-first with background sync**.

## 1. What changes, what doesn't

Unchanged: the Python engine, the recommendation math, IndexedDB as the local
working store, the whole offline app shell. The engine still reads a plain
`{grinder, coffees, brews}` payload — it never talks to Firebase.

Added: a thin **sync layer** that mirrors local data to Firestore and pulls
remote changes back into IndexedDB. IndexedDB stays the source of truth the UI
and engine read from; Firestore is the shared backup/merge point.

```
UI  ──►  IndexedDB (local truth)  ──►  engine (recommend)
             ▲   │
     pull    │   │  push (when online)
             │   ▼
        Firestore  (household-scoped shared copy)
```

## 2. Auth & household model

- **Sign-in**: Google, via Firebase Auth. Each person = one `uid`.
- **Household**: a Firestore doc that both users belong to. Created by the first
  user; the second joins with a 6-char **invite code**.
- All coffee/brew/grinder data is stored **under the household**, not the user,
  so both see the same set. We still stamp each write with `authorUid` so you
  can later show "logged by Max" if you want.

## 3. Firestore data model

```
households/{householdId}
  name: string
  members: { <uid>: {role:"owner"|"member", displayName} }
  memberUids: [<uid>, ...]         // flat array for security-rule checks
  inviteCode: string               // 6 chars; rotatable
  grinder: { name, min, max, step, calibration }   // shared (per your choice)

households/{householdId}/coffees/{coffeeId}
  name, roast, process, roastDate, origin, variety, altitudeMasl, decaf, notes,
  createdAt, archived, updatedAt, authorUid

households/{householdId}/brews/{brewId}
  coffeeId, method, grindSetting, verdict, doseG?, yieldG?, shotTimeS?,
  brewTimeS?, waterTempC?, createdAt, updatedAt, authorUid

users/{uid}
  householdId: string              // which household this user is in
  displayName, email
```

IDs: generate **client-side UUIDs** for coffees/brews (not Firestore
auto-ids). That lets a brew created offline keep the same id when it syncs, so
there are no duplicates and local↔remote map 1:1.

## 4. Sync strategy (offline-first)

**Local truth + last-writer-wins per record.**

Every coffee/brew/grinder carries `updatedAt` (ms epoch, client clock).

- **Write path**: UI writes to IndexedDB immediately (app feels instant, works
  offline). A dirty-queue marks the record for upload. When online, push to
  Firestore.
- **Read path**: subscribe to the household's Firestore collections
  (`onSnapshot`). On any remote change, upsert into IndexedDB **iff**
  `remote.updatedAt >= local.updatedAt` (last-writer-wins). Then re-render.
- **Conflict rule**: two edits to the *same* record → higher `updatedAt` wins.
  Two edits to *different* records → both kept (union). Deletions use a
  `deleted:true` tombstone with its own `updatedAt` so a delete can't be
  silently resurrected by an older edit.

Firestore's SDK already provides offline persistence + automatic retry, so
"background sync" is mostly free: writes made offline flush when the network
returns. We keep our own IndexedDB too because the engine reads from it and we
want full control of the merge.

Why last-writer-wins (not CRDT): two people, low write rate, rare true
conflicts. LWW is a few lines and good enough. A merge-heavy scheme would be
over-engineering here.

## 5. Security rules (the important part)

Only household members can read/write that household's data. Sketch:

```
match /households/{hid} {
  allow read: if isMember(hid);
  allow create: if request.auth != null
                && request.resource.data.memberUids.hasOnly([request.auth.uid]);
  allow update: if isMember(hid);          // joining adds uid via a checked path

  match /{sub=**} {                        // coffees, brews
    allow read, write: if isMember(hid);
  }
}
match /users/{uid} {
  allow read, write: if request.auth.uid == uid;
}
function isMember(hid) {
  return request.auth != null &&
    request.auth.uid in get(/databases/$(database)/documents/households/$(hid)).data.memberUids;
}
```

Joining by code needs care: a non-member can't yet read the household to check
the code. Pattern: a small **Cloud Function** (or a public
`inviteCodes/{code} -> householdId` lookup doc) validates the code and adds the
uid to `memberUids`. Simplest no-Functions version: keep a top-level
`invites/{code}` doc readable by any signed-in user that maps code→hid; joining
writes the uid into the household via a rule that permits adding *only your own*
uid when you present a valid code. (Details in the build step.)

## 6. Integration points in existing code

- `web/js/db.js` — add `updatedAt`, client-UUID ids, a `dirty` flag, and
  `deleted` tombstones to writes. New helpers: `pending()`, `markSynced(id)`,
  `upsertFromRemote(rec)`.
- **New** `web/js/sync.js` — init Firebase, auth, household create/join,
  `onSnapshot` subscriptions, push loop for dirty records.
- **New** `web/js/auth-ui.js` (or fold into app.js) — sign-in screen, household
  create/join screen, "invite code" display in Settings.
- `web/js/app.js` — after sign-in + household resolved, run initial sync, then
  render as today. If signed-out, the app can still run **local-only** (sync is
  additive, not required).
- `web/index.html` — add Firebase SDK (vendored for offline, like Pyodide) and
  a `firebase-config.js` with your project keys (safe to ship; security is in
  the rules, not the keys).

## 7. Firebase project setup (you do once, in console)

1. console.firebase.google.com → Add project (free Spark plan, no card).
2. Build → Authentication → enable **Google** provider.
3. Build → Firestore Database → create (production mode).
4. Paste the security rules (we'll finalize them in the build step).
5. Project settings → Web app → copy the config object into
   `web/js/firebase-config.js`.
6. Auth → Settings → Authorized domains → add
   `maxb-coder.github.io` so Google sign-in works on your Pages URL.

## 8. Rollout plan

1. **Phase 1 — local-first refactor** (no Firebase yet): add `updatedAt`,
   client UUIDs, tombstones, dirty flag to db.js. App behaves identically.
   Ship + verify nothing broke. (Safe, reversible.)
2. **Phase 2 — auth + household**: sign-in, create/join by code, store
   `householdId`. Still no data sync. Verify two accounts can join one household.
3. **Phase 3 — sync engine**: push dirty records, subscribe to remote, merge by
   LWW into IndexedDB. This is the real work; test with two browser profiles.
4. **Phase 4 — polish**: "logged by", offline badge, invite-code rotation,
   conflict edge cases, vendored Firebase SDK for full offline.

## 9. Honest trade-offs

- This ends the "data never leaves the device" property: brews now live in
  Google's Firestore. That's the unavoidable cost of shared sync.
- Google sign-in means each of you needs a Google account (you both do).
- Offline still works fully; sync catches up when online. But a *first* run on a
  new device needs one online moment to pull the household.
- Free tier is ample for two users and won't auto-pause (unlike Supabase).
```
```
