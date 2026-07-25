// Pyodide bridge: loads the CPython/Wasm runtime + the pure-Python engine,
// then exposes recommend(payload) -> object. Strings cross the boundary only.
//
// OFFLINE NOTE: PYODIDE_URL points at the CDN for zero-setup dev. For a fully
// offline PWA, vendor Pyodide into web/vendor/pyodide/ and set
//   const PYODIDE_URL = "./vendor/pyodide/";
// and precache it in sw.js. See build plan §7.

// Vendored for full offline. Run scripts/fetch_pyodide.sh once to populate
// web/vendor/pyodide/. To fall back to the CDN, set this to
//   "https://cdn.jsdelivr.net/pyodide/v0.26.2/full/"
const PYODIDE_URL = "./vendor/pyodide/";
const ENGINE_FILES = ["__init__.py", "features.py", "ridge.py", "recommend.py"];

let py = null;
let ready = null;

export function initEngine(onStatus = () => {}) {
  if (ready) return ready;
  ready = (async () => {
    onStatus("Loading Python runtime…");
    // loadPyodide is provided by the pyodide.js script tag in index.html
    py = await loadPyodide({ indexURL: PYODIDE_URL });
    onStatus("Loading numpy…");
    await py.loadPackage("numpy");

    onStatus("Loading engine…");
    py.FS.mkdirTree("/app/engine");
    for (const f of ENGINE_FILES) {
      const src = await (await fetch(`./py/engine/${f}`)).text();
      py.FS.writeFile(`/app/engine/${f}`, src);
    }
    const synth = await (await fetch("./py/engine/synthetic.json")).text();
    py.FS.writeFile("/app/engine/synthetic.json", synth);

    py.runPython(`import sys; sys.path.insert(0, "/app"); from engine import run as _run`);
    onStatus("Ready");
  })();
  return ready;
}

export async function recommend(payload) {
  await ready;
  const run = py.globals.get("_run");
  const out = run(JSON.stringify(payload));  // JSON string in
  run.destroy();
  return JSON.parse(out);                     // JSON string out
}
