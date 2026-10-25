# hbox-term developer guide

## Build from source

Install a current Node.js, Rust, and the [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/).
On Debian or Ubuntu:

```sh
sudo apt install libwebkit2gtk-4.1-dev build-essential libxdo-dev libssl-dev \
  libayatana-appindicator3-dev librsvg2-dev
```

Then use the Makefile (`make` lists every target):

```sh
make dev           # run with hot reload
make test          # frontend (node --test) and backend (cargo test) tests
make lint          # tsc and clippy
make build         # release bundles for this OS
make build-debug   # debug binary with the frontend embedded
make run-release   # optimized binary, for benchmarks
```

If the build cannot find `webkit2gtk-4.1` or `libsoup-3.0` although they are installed, another
`pkg-config` (for example Homebrew's) is first on your `PATH`. Point Cargo at the system one with
`PKG_CONFIG=/usr/bin/pkg-config`.

## Architecture

The TypeScript frontend (no framework) talks to the Rust backend only through typed Tauri commands.
Rust owns persistence, the credential vault, SSH, SFTP, local PTYs and remote capability providers.
Terminal output reaches the frontend as raw bytes over a Tauri channel, batched per frame with
flow control.

```text
TypeScript frontend (src/app)
        |  Tauri commands + binary output channels
        v
Rust backend (src-tauri/src): storage, vault, SSH, local PTY, SFTP, providers
        |
        +--> local shell (PTY)
        +--> Linux servers over SSH (no agent)
```

## Releasing

1. Set the version in `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` and `package.json`.
2. Add a `## X.Y.Z - date` section to `CHANGELOG.md`; it becomes the release notes and the notes
   shown in the app's update dialog.
3. Commit, then push a `vX.Y.Z` tag.

The tag runs `.github/workflows/release.yml`. It checks the version and changelog, builds the
Linux (`.deb`, `.rpm`, `.AppImage`; x86_64 and ARM64) and macOS (`.dmg` and the updater's
`.app.tar.gz`; Intel and Apple Silicon) packages into a draft release, adds `latest.json` for the
in-app updater and `SHA256SUMS.txt` for `install.sh`, and publishes the release. Published
releases are what `install.sh` and the updater see; fix mistakes with a new version.

### Updater signing

In-app updates are verified against the public key in `src-tauri/tauri.conf.json`
(`plugins.updater.pubkey`). The release workflow signs with the repository secret
`TAURI_SIGNING_PRIVATE_KEY` (and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` if the key has one) and
refuses to run without it. `tools/update-manifest.mjs` rejects a release whose signatures come from
another key or that lacks a platform.

Keep a backup of the private key: installed copies only accept updates signed with it, so losing
it means users must reinstall by hand. For a local signed build:

```sh
export TAURI_SIGNING_PRIVATE_KEY="$PWD/.secrets/hbox-term-updater.key" TAURI_SIGNING_PRIVATE_KEY_PASSWORD=''
make build
```

`.secrets/` is ignored by git. To test an update locally, build an older version with
`--config` pointing `plugins.updater.endpoints` at a local server (plus
`"dangerousInsecureTransportProtocol": true` for plain HTTP) and serve a `latest.json` there.
