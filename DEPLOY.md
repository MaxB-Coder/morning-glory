# Deploy Morning Glory to GitHub Pages + install on iPhone

Your GitHub username: **MaxB-Coder**. Final URL will be:
**https://MaxB-Coder.github.io/morning-glory/**

Run everything from inside the project folder (the one containing `web/`).

## 1. Vendor Pyodide (one time — makes it work offline)

```bash
bash scripts/fetch_pyodide.sh      # downloads the Python runtime into web/vendor/pyodide
bash scripts/sync_engine.sh        # copies the engine into web/py
```

Verify it runs locally before deploying:

```bash
python3 -m http.server -d web 8000
# open http://localhost:8000  — should load with NO internet after first time
```

## 2. Create the repo and push

If you've never used git here, set your identity once:
```bash
git config --global user.name "Max"
git config --global user.email "you@example.com"
```

Then:
```bash
git init
git add -A
git commit -m "Morning Glory: coffee grind recommender"
git branch -M main
```

Create an empty repo named **morning-glory** on github.com (no README), then:
```bash
git remote add origin https://github.com/MaxB-Coder/morning-glory.git
git push -u origin main
```

## 3. Turn on Pages, serving the web/ folder

GitHub Pages serves either the repo root or `/docs`, not an arbitrary subfolder.
Easiest: publish with an Action that serves `web/`. Simplest-of-all: put the app
at the repo root. Pick ONE:

**Option A — move the app to the repo root (simplest).**
Before the first commit, move everything in `web/` up one level so `index.html`
sits at the repo root. Then in GitHub: **Settings → Pages → Source: Deploy from
a branch → main / (root) → Save.**

**Option B — keep `web/` and use a Pages Action.**
Add `.github/workflows/pages.yml` (already included in this project) and set
**Settings → Pages → Source: GitHub Actions.** It uploads `web/` for you.

Either way, wait ~1 minute, then visit:
**https://MaxB-Coder.github.io/morning-glory/**

## 4. Install on iPhone

1. Open that URL in **Safari** (not Chrome — only Safari can install PWAs on iOS).
2. Tap the **Share** icon → **Add to Home Screen** → Add.
3. Launch it from the new icon. First open downloads the runtime; after that it
   works in airplane mode. All data stays on your phone.

## Updating later
```bash
# make changes, then:
bash scripts/sync_engine.sh        # if you touched the engine
git add -A && git commit -m "update" && git push
```
Pages redeploys in ~1 minute. On the phone, reopen the app; the service worker
picks up the new version (it bumps its cache name on each release — see sw.js).

## 5. Enable sharing/sync (optional — Firebase)

The app works fully without this (local-only). To share with another person:

1. console.firebase.google.com → **Add project** (free Spark plan, no card).
2. **Build → Authentication → Sign-in method → enable Google.**
3. **Build → Firestore Database → Create database** (Production mode).
4. **Firestore → Rules** → paste the contents of `firestore.rules` → **Publish.**
5. **Project settings → General → Your apps → Web app** (`</>`), register one,
   copy the `firebaseConfig` object into `web/js/firebase-config.js`.
6. **Authentication → Settings → Authorized domains → Add domain**
   `maxb-coder.github.io` (so Google sign-in works on your Pages URL).
7. Commit + push. In the app: Settings → Sharing → **Sign in with Google** →
   **Create household** → share the 6-char code. Your gf signs in on her phone
   and taps **Join** with that code. Both now sync.

Notes on sync: it's offline-first — logging works with no signal and uploads
when you're back online. Conflicts resolve last-writer-wins per record. Data
now lives in your Firebase project (Google), which is the trade-off for sharing.

## Notes
- `web/.nojekyll` is required so GitHub Pages serves the `py/` and `vendor/`
  folders untouched.
- Repo will be ~25MB because of the vendored Pyodide runtime. That's expected
  and is what makes the app fully offline.
