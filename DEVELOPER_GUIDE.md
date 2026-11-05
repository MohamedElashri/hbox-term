# Ternway developer guide

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
export TAURI_SIGNING_PRIVATE_KEY="$PWD/.secrets/ternway-updater.key" TAURI_SIGNING_PRIVATE_KEY_PASSWORD=''
make build
```

`.secrets/` is ignored by git. To test an update locally, build an older version with
`--config` pointing `plugins.updater.endpoints` at a local server (plus
`"dangerousInsecureTransportProtocol": true` for plain HTTP) and serve a `latest.json` there.

### Agent test prerequisites

The normal suite uses OpenSSH `ssh-agent`, `ssh-add` and `ssh-keygen` with a
disposable agent/key fixture. macOS includes these tools; on Linux install
`openssh-client`. It does not use your current agent or contact a remote host.
Real-host and password-manager tests remain explicit opt-in checks.

## App regression checks

Use Node.js 24.15 or newer in the 24.x line, or Node.js 26, for the frontend tests.
`make test` includes DOM tests for dialog focus, form retention and custom selects, plus
connection-save, SSH cancellation, updater and session-write tests. A command-contract test
checks frontend IPC names against the registered Rust commands.

Build an isolated macOS app with `make qa-macos`. Keep QA connections in its separate data
directory; use loopback hosts and disposable import files for library and error-path checks.
Check Tab/Shift-Tab/Escape in dialogs, Save versus Save & test, grouped import and search,
terminal splits and renderer changes, and immediate quit/reopen with a renamed tab.

Run `npm audit` when dependencies change. macOS and Linux CI run the frontend build and both
test suites. Live password-manager authentication and remote administration need separate
integration checks; passing fixture tests does not verify those external systems.

### Password login and SSH config fixtures

`make test` checks password prompt recovery/cancellation, session-only versus encrypted-vault
storage, Git service classification, conditional Includes and static config parity with OpenSSH.
Only generated, command-free fixtures are passed to `ssh -G`; importing user config never
executes SSH, Match exec or ProxyCommand.

The macOS/Linux CI also runs a disposable loopback SSH server to test password authentication,
keyboard-interactive passwords, fallback, rejected credentials and a command after login:

```sh
python3 -m venv /tmp/ternway-ssh-tests
/tmp/ternway-ssh-tests/bin/python -m pip install -r tests/fixtures/requirements.txt
TERNWAY_SSH_TEST_PYTHON=/tmp/ternway-ssh-tests/bin/python make test-ssh-password
```

The fixture uses no real accounts and does not read or modify user SSH configuration or host
trust. It tests authentication directly on an isolated SSH session; host-key storage and trust dialogs are
outside this fixture. Runtime-dependent config and unsupported routing are shown as requiring
manual configuration in the importer. This is not a complete replacement for OpenSSH config.

### Native OpenSSH compatibility

See [OpenSSH connections](docs/OPENSSH.md) for supported workflows and current limits.
With the same fixture virtualenv as the password tests, run:

```sh
TERNWAY_SSH_TEST_PYTHON=/tmp/ternway-ssh-tests/bin/python make test-openssh
```

This launches the real OpenSSH client through the application's PTY backend, with generated
keys and isolated host trust. It never reads user SSH config or uses a real account. Both
macOS and Linux CI run it after the managed password authentication fixture. Checks run on
pull requests and main-branch pushes, avoiding duplicate builds for each PR commit.
