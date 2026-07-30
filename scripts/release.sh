#!/usr/bin/env bash
# Bump the app version in ALL the places that must agree, sync the engine,
# and (optionally) commit + push.
#
# Semantic versioning — MAJOR.MINOR.PATCH:
#   patch  fixes and small tweaks that don't change how the app is used
#   minor  new features that don't break anything (favourites, new verdicts…)
#   major  breaking changes (a data migration, a redesign you'd want to flag)
#
#   bash scripts/release.sh                          # patch: 1.0.0 -> 1.0.1
#   bash scripts/release.sh --minor                  # 1.0.1 -> 1.1.0
#   bash scripts/release.sh --major                  # 1.1.0 -> 2.0.0
#   bash scripts/release.sh 1.4.2                    # set explicitly
#   bash scripts/release.sh --push "what changed"    # patch, commit and push
#   bash scripts/release.sh --minor --push "msg"     # combine
#
# The three places that MUST stay in lockstep:
#   web/js/app.js    APP_VERSION  -> what the running build reports
#   web/version.json version      -> what the server advertises (update check)
#   web/sw.js        CACHE        -> forces the service worker to refresh
# Out of step means either "update available" forever, or users silently stuck
# on an old cached build. Hence this script, and the check at the end.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

SEMVER='[0-9]+\.[0-9]+\.[0-9]+'

current="$(grep -oE "APP_VERSION = \"$SEMVER\"" web/js/app.js | grep -oE "$SEMVER" || true)"
[ -n "$current" ] || { echo "could not read a semver APP_VERSION from web/js/app.js"; exit 1; }

bump="patch"; explicit=""; do_push=0; msg=""
while [ $# -gt 0 ]; do
  case "$1" in
    --major) bump="major" ;;
    --minor) bump="minor" ;;
    --patch) bump="patch" ;;
    --push)  do_push=1; if [ $# -gt 1 ]; then msg="$2"; shift; fi ;;
    *)
      if echo "$1" | grep -qE "^$SEMVER$"; then explicit="$1";
      else echo "unrecognised argument: $1"; exit 1; fi ;;
  esac
  shift
done

if [ -n "$explicit" ]; then
  next="$explicit"
else
  IFS='.' read -r MA MI PA <<< "$current"
  case "$bump" in
    major) next="$((MA + 1)).0.0" ;;
    minor) next="$MA.$((MI + 1)).0" ;;
    patch) next="$MA.$MI.$((PA + 1))" ;;
  esac
fi

echo "  $current  ->  $next  ($bump)"

# perl -pi (not `sed -i`): BSD/macOS sed requires a backup-suffix argument
# after -i, which silently eats part of the filename on a Mac.
perl -pi -e "s/APP_VERSION = \"\Q$current\E\"/APP_VERSION = \"$next\"/" web/js/app.js
printf '{ "version": "%s" }\n' "$next" > web/version.json
perl -pi -e "s/const CACHE = \"gw-\Q$current\E\"/const CACHE = \"gw-$next\"/" web/sw.js

# keep the browser copy of the engine identical to the tested one
bash scripts/sync_engine.sh >/dev/null

# verify all three agree before anyone ships a mismatch
a="$(grep -oE "APP_VERSION = \"$SEMVER\"" web/js/app.js | grep -oE "$SEMVER")"
b="$(grep -oE "\"version\": \"$SEMVER\"" web/version.json | grep -oE "$SEMVER")"
c="$(grep -oE "CACHE = \"gw-$SEMVER\"" web/sw.js | grep -oE "$SEMVER")"
if [ "$a" != "$next" ] || [ "$b" != "$next" ] || [ "$c" != "$next" ]; then
  echo "MISMATCH after bump: app.js=$a version.json=$b sw.js=$c"; exit 1
fi
echo "  app.js / version.json / sw.js all at $next"

if [ "$do_push" -eq 1 ]; then
  git add -A
  git commit -m "${msg:-release} (v$next)"
  git push
  echo "  pushed."
else
  echo "  version bumped only. To ship it:"
  echo "    bash scripts/release.sh --push \"what changed\""
fi
