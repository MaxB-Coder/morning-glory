#!/usr/bin/env bash
# Download the Pyodide runtime into web/vendor/pyodide/ so the app runs fully
# offline (no CDN). Run this ONCE on your machine before deploying.
#
#   bash scripts/fetch_pyodide.sh
#
# Needs curl + tar (both preinstalled on macOS).
set -euo pipefail

VER="0.26.2"
URL="https://github.com/pyodide/pyodide/releases/download/${VER}/pyodide-${VER}.tar.bz2"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/web/vendor/pyodide"
TMP="$(mktemp -d)"

echo "Downloading Pyodide ${VER} (~200MB compressed)…"
curl -L --fail -o "$TMP/pyodide.tar.bz2" "$URL"

echo "Extracting…"
tar -xjf "$TMP/pyodide.tar.bz2" -C "$TMP"

mkdir -p "$DEST"
# The tarball extracts to a 'pyodide/' folder. We only need the runtime files
# the app actually loads: the loader, wasm, lockfile, stdlib, and numpy wheel.
SRC="$TMP/pyodide"
KEEP=(
  pyodide.js pyodide.mjs pyodide.asm.js pyodide.asm.wasm
  pyodide-lock.json python_stdlib.zip
)
for f in "${KEEP[@]}"; do
  [ -f "$SRC/$f" ] && cp "$SRC/$f" "$DEST/" && echo "  + $f"
done
# numpy wheel (name includes a version/platform tag)
cp "$SRC"/numpy-*.whl "$DEST/" 2>/dev/null && echo "  + numpy wheel" || \
  echo "  ! numpy wheel not found — check the tarball contents"

rm -rf "$TMP"
echo
echo "Done. Vendored into: $DEST"
du -sh "$DEST"
echo "Now: bash scripts/sync_engine.sh && python3 -m http.server -d web 8000"
