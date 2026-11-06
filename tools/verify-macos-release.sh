#!/usr/bin/env bash
set -euo pipefail
app="$1"
codesign --verify --deep --strict --verbose=2 "$app"
details="$(codesign -dv --verbose=4 "$app" 2>&1)"
if [[ "$details" != *'Authority=Developer ID Application:'* || "$details" != *'(runtime)'* ]]; then
  echo 'A production macOS bundle must use Developer ID signing and the hardened runtime.' >&2
  exit 1
fi
spctl --assess --type execute --verbose=2 "$app"
xcrun stapler validate "$app"
if [[ -n "${2:-}" ]]; then
  hdiutil verify "$2"
  xcrun stapler validate "$2"
fi
