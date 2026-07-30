// Service worker: precache the app shell + vendored Pyodide for TRUE offline.
// Bump CACHE whenever you change any cached asset.
//
// The core Pyodide files are precached on install. The numpy wheel and any
// stdlib chunks Pyodide requests at runtime are cached on first use by the
// runtime-cache fetch handler below, so a second launch works in airplane mode.
const CACHE = "gw-1.1.8";
const ASSETS = [
  "./",
  "./index.html",
  "./manifest.json",
  "./css/pico.min.css",
  "./css/app.css",
  "./js/app.js",
  "./js/db.js",
  "./js/bridge.js",
  "./js/sw-register.js",
  "./js/sync.js",
  "./js/firebase-config.js",
  "./py/engine/__init__.py",
  "./py/engine/features.py",
  "./py/engine/ridge.py",
  "./py/engine/recommend.py",
  "./py/engine/synthetic.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  // vendored Pyodide core (fetch_pyodide.sh populates these)
  "./vendor/pyodide/pyodide.js",
  "./vendor/pyodide/pyodide.asm.js",
  "./vendor/pyodide/pyodide.asm.wasm",
  "./vendor/pyodide/pyodide-lock.json",
  "./vendor/pyodide/python_stdlib.zip",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) =>
      // add individually so one missing/renamed vendor file can't fail install
      Promise.all(ASSETS.map((a) =>
        c.add(a).catch((err) => console.warn("[sw] skip", a, err.message))))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  // version.json must ALWAYS come from the network, otherwise the update
  // check would compare against a cached copy and never see a new release.
  if (new URL(e.request.url).pathname.endsWith("/version.json")) return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return; // let cross-origin pass through

  // Cache-first, then runtime-cache the response. This picks up the files
  // Pyodide requests lazily (numpy wheel, stdlib chunks) on first online load
  // so airplane-mode relaunches have everything.
  e.respondWith(
    caches.match(e.request).then((hit) =>
      hit || fetch(e.request).then((res) => {
        if (res.ok && res.type === "basic") {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      }).catch(() => caches.match("./index.html")) // offline nav fallback
    )
  );
});
