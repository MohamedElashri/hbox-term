#!/usr/bin/env bash
set -euo pipefail
app="$1"
codesign --verify --deep --strict --verbose=2 "$app"
details="$(codesign -dv --verbose=4 "$app" 2>&1)"
if [[ "$details" != *'Signature=adhoc'* ]]; then
  echo 'A macOS release bundle must use the configured ad-hoc signature.' >&2
  exit 1
fi
if [[ -n "${2:-}" ]]; then
  hdiutil verify "$2"
fi
echo 'Verified ad-hoc signature integrity. This build is not notarized by Apple.'
