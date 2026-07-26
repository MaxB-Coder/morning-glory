#!/usr/bin/env bash
# Bump the app version in ALL the places that must agree, sync the engine,
# and (optionally) commit + push.
#
#   bash scripts/release.sh              # auto-increment v19 -> v20
#   bash scripts/release.sh v25          # set an explicit version
#   bash scripts/release.sh --push "msg" # bump, commit and push
#
# The three places that MUST stay in lockstep:
#   web/js/app.js   APP_VERSION   -> what the running build reports
#   web/version.json version      -> what the server advertises (update check)
#   web/sw.js       CACHE         -> forces the service worker to refresh
# Getting these out of step means either "update available" forever, or users
# silently stuck on an old cached build. Hence this script.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

current="$(sed -n 's/.*APP_VERSION = "\(v[0-9]*\)".*/\1/p' web/js/app.js)"
[ -n "$current" ] || { echo "could not read APP_VERSION from web/js/app.js"; exit 1; }

if [ "${1:-}" != "" ] && [ "${1:-}" != "--push" ]; then
  next="$1"; shift
else
  next="v$(( ${current#v} + 1 ))"
fi

echo "  $current  ->  $next"

# perl -pi (not `sed -i`): BSD/macOS sed requires a backup-suffix argument
# after -i, which silently eats part of the filename on a Mac.
# 1. app.js
perl -pi -e "s/APP_VERSION = \"\Q$current\E\"/APP_VERSION = \"$next\"/" web/js/app.js
# 2. version.json
printf '{ "version": "%s" }\n' "$next" > web/version.json
# 3. sw.js cache name
perl -pi -e "s/const CACHE = \"gw-\Q$current\E\"/const CACHE = \"gw-$next\"/" web/sw.js

# keep the browser copy of the engine identical to the tested one
bash scripts/sync_engine.sh >/dev/null

# verify all three agree before anyone ships a mismatch
a="$(sed -n 's/.*APP_VERSION = "\(v[0-9]*\)".*/\1/p' web/js/app.js)"
b="$(sed -n 's/.*"version": "\(v[0-9]*\)".*/\1/p' web/version.json)"
c="$(sed -n 's/.*const CACHE = "gw-\(v[0-9]*\)".*/\1/p' web/sw.js)"
if [ "$a" != "$next" ] || [ "$b" != "$next" ] || [ "$c" != "$next" ]; then
  echo "MISMATCH after bump: app.js=$a version.json=$b sw.js=$c"; exit 1
fi
echo "  app.js / version.json / sw.js all at $next"

if [ "${1:-}" = "--push" ]; then
  msg="${2:-release $next}"
  git add -A
  git commit -m "$msg ($next)"
  git push
  echo "  pushed."
else
  echo "  next:  git add -A && git commit -m \"...\" && git push"
fi
