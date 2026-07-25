#!/usr/bin/env bash
# Copy the single-source-of-truth Python engine into the web app.
# Run before serving or deploying. Never edit web/py/ by hand.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
dest="$here/web/py/engine"
mkdir -p "$dest"
cp "$here"/engine/__init__.py "$here"/engine/features.py \
   "$here"/engine/ridge.py "$here"/engine/recommend.py \
   "$here"/engine/synthetic.json "$dest/"
echo "synced engine -> $dest"
