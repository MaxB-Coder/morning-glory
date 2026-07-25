# GrindWise

Offline-first coffee-grind recommender. Pure-Python engine runs in the browser
via Pyodide (WebAssembly). Register a coffee, pick a brew method, get a grind
setting; log good / sour / bitter and it learns your dial.

## Layout
```
engine/     pure Python engine (tested on desktop, shipped to browser verbatim)
tests/      pytest suite (23 tests)
web/        the PWA (deploy this folder)
scripts/    gen_synthetic.py, sync_engine.sh
```
`web/py/engine/` is a COPY of `engine/` — never edit it by hand. Run
`scripts/sync_engine.sh` after changing the engine.

## Run the engine tests (desktop)
```
pip install numpy pytest         # or: uv sync
python scripts/gen_synthetic.py  # (re)build the pretraining data
python -m pytest -q
```

## Run the app locally
```
bash scripts/sync_engine.sh
python -m http.server -d web 8000
```
Open http://localhost:8000 . First load fetches Pyodide from a CDN (~one-time).
On your phone: same Wi-Fi → http://<your-computer-ip>:8000 .

## Deploy (free, HTTPS, installable)
Push `web/` to GitHub Pages (or any static host). HTTPS is required for the
service worker / "Add to Home Screen" on iOS. GitHub Pages provides it.

## True offline (airplane mode)
By default Pyodide loads from a CDN, so the very first launch needs internet.
For fully offline:
1. Download a Pyodide release (core + numpy wheel) into `web/vendor/pyodide/`.
2. In `web/index.html` point the `<script>` at `./vendor/pyodide/pyodide.js`.
3. In `web/js/bridge.js` set `PYODIDE_URL = "./vendor/pyodide/"`.
4. Add the vendored files to the `ASSETS` list in `web/sw.js`, bump `CACHE`.
After one online load, the app works with no network.

## How it learns
- Ships with ~500 synthetic brews encoding coffee science → sane day-1 numbers.
- Every logged brew becomes a training sample (good = target; sour = finer;
  bitter = coarser), weighted 5× vs synthetic; synthetic fades as you log more.
- A per-coffee offset makes each specific bag converge in ~3 brews.
All of this is `engine/recommend.py`; see `grindwise-build-plan-python.md`.

## The JS ↔ Python contract
One function. JS sends a JSON string, gets a JSON string back:
`engine.run(payload_json) -> result_json`. Keeps Pyodide proxy objects out of
the way. See `engine/recommend.py` docstring for the payload shape.
```

## Data & privacy
Everything lives in the browser's IndexedDB on your device. Nothing is sent
anywhere. Export a JSON backup from Settings periodically — browsers can evict
IndexedDB.
