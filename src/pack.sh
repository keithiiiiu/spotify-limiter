#!/usr/bin/env bash
# Builds a PRODUCTION package: test controls are switched off.
set -euo pipefail
cd "$(dirname "$0")"
rm -rf dist && mkdir dist
cp -r manifest.json config.js core.js background.js content.js pip-guard.js popup.html popup.css popup.js icons dist/

# Flip the debug switch (line marked @DEBUG_FLAG in config.js)
sed -i.bak -E '/@DEBUG_FLAG/ s/enabled: *true/enabled: false/' dist/config.js && rm dist/config.js.bak
grep -E '@DEBUG_FLAG' dist/config.js | grep -q 'enabled: false' || { echo "ERROR: debug flag still on"; exit 1; }

VERSION=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' manifest.json | head -1)
rm -f "spotify-limiter-$VERSION.zip"
(cd dist && zip -qr "../spotify-limiter-$VERSION.zip" .)
echo "Built dist/ and spotify-limiter-$VERSION.zip (debug OFF)"
