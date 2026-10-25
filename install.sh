#!/bin/sh
# Install hbox-term from GitHub releases on Linux or macOS.
#
#   curl -fsSL https://raw.githubusercontent.com/MohamedElashri/hbox-term/main/install.sh | sh
#
# HBOX_TERM_VERSION=v0.1.0 pins a release (default: latest). An authenticated `gh` CLI is used
# when available, which avoids API rate limits.
set -eu

repo=MohamedElashri/hbox-term
tag=${HBOX_TERM_VERSION:-latest}
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
die() { echo "hbox-term install: $*" >&2; exit 1; }
wanted=$tag
no_release() {
  [ "$wanted" = latest ] && what="no release" || what="no release $wanted"
  die "$what yet. Build from source instead:
  git clone https://github.com/$repo && cd hbox-term && make build"
}

if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  if [ "$tag" = latest ]; then
    tag=$(gh release view -R "$repo" --json tagName --jq .tagName 2>/dev/null) || no_release
  fi
  gh release view "$tag" -R "$repo" --json assets --jq '.assets[].name' > "$tmp/names" 2>/dev/null || no_release
  fetch() { gh release download "$tag" -R "$repo" -p "$1" -D "$tmp"; }
else
  command -v curl >/dev/null 2>&1 || die "curl is required"
  [ "$tag" = latest ] && path=latest || path="tags/$tag"
  curl -fsSL "https://api.github.com/repos/$repo/releases/$path" > "$tmp/release.json" 2>/dev/null || no_release
  tag=$(sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' "$tmp/release.json" | head -n 1)
  sed -n 's/.*"browser_download_url": *"[^"]*\/\([^"/]*\)".*/\1/p' "$tmp/release.json" > "$tmp/names"
  fetch() { curl -fsSL -o "$tmp/$1" "https://github.com/$repo/releases/download/$tag/$1"; }
fi

case "$(uname -m)" in
  x86_64 | amd64) arch='(x86_64|amd64|x64)' ;;
  aarch64 | arm64) arch='(aarch64|arm64)' ;;
  *) die "unsupported architecture $(uname -m)" ;;
esac
case "$(uname -s)" in
  Darwin) ext='\.dmg$' ;;
  Linux)
    if command -v apt-get >/dev/null 2>&1; then ext='\.deb$'
    elif command -v dnf >/dev/null 2>&1 || command -v zypper >/dev/null 2>&1; then ext='\.rpm$'
    else ext='\.AppImage$'; fi ;;
  *) die "unsupported system; hbox-term supports Linux and macOS" ;;
esac

asset=$(grep -E "$arch.*$ext" "$tmp/names" | head -n 1) || true
[ -n "$asset" ] || die "release $tag has no package for $(uname -s) $(uname -m)"
echo "Downloading $asset ($tag)"
fetch "$asset"
fetch SHA256SUMS.txt
if command -v sha256sum >/dev/null 2>&1; then sum='sha256sum -c -'; else sum='shasum -a 256 -c -'; fi
(cd "$tmp" && grep "  $asset\$" SHA256SUMS.txt | $sum >/dev/null) || die "checksum mismatch for $asset"

file="$tmp/$asset"
case "$asset" in
  *.dmg)
    hdiutil attach -nobrowse -quiet -mountpoint "$tmp/mnt" "$file"
    rm -rf /Applications/hbox-term.app
    cp -R "$tmp/mnt/hbox-term.app" /Applications/
    hdiutil detach -quiet "$tmp/mnt"
    # The app is not notarized; drop the download quarantine so it opens.
    xattr -dr com.apple.quarantine /Applications/hbox-term.app 2>/dev/null || true
    echo "Installed /Applications/hbox-term.app" ;;
  *.deb) sudo apt-get install -y "$file" ;;
  *.rpm)
    if command -v dnf >/dev/null 2>&1; then sudo dnf install -y "$file"
    else sudo zypper --non-interactive install --allow-unsigned-rpm "$file"; fi ;;
  *.AppImage)
    mkdir -p "$HOME/.local/bin" "$HOME/.local/share/applications"
    install -m 755 "$file" "$HOME/.local/bin/hbox-term"
    printf '[Desktop Entry]\nType=Application\nName=hbox-term\nComment=Terminal for local and remote development\nExec=%s\nTerminal=false\nCategories=Development;System;TerminalEmulator;\n' \
      "$HOME/.local/bin/hbox-term" > "$HOME/.local/share/applications/hbox-term.desktop"
    echo "Installed $HOME/.local/bin/hbox-term" ;;
esac
