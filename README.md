# Ternway

**Your machines. One workspace.** Previously hbox-term.

![Ternway](docs/branding/ternway/release-banner.svg)

[![Release](https://img.shields.io/github/v/release/MohamedElashri/hbox-term?include_prereleases&sort=semver)](https://github.com/MohamedElashri/hbox-term/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A desktop terminal for local and remote development on Linux and macOS, built with Rust and
Tauri 2. It opens straight into your local shell and keeps your servers next to it: SSH terminals,
files, services, containers and logs, with nothing installed on the remote side.

<p align="center">
  <img src="docs/images/screenshot.png" width="900" alt="hbox-term with three local tabs, the first split into cargo test output, a log stream with a highlighted error, and git log; servers grouped in the sidebar">
</p>


The [user guide](USER_GUIDE.md) covers everything in detail, and the [changelog](CHANGELOG.md)
lists what each release adds.

## Install

**Linux and macOS:**

```sh
curl -fsSL https://raw.githubusercontent.com/MohamedElashri/hbox-term/main/install.sh | sh
```

The script picks the right package (`.deb`, `.rpm` or AppImage on Linux, the `.dmg` for your Mac's
architecture), verifies it against `SHA256SUMS.txt` and installs it. Set `HBOX_TERM_VERSION=v0.1.0`
to pin a release.

**Manual download:** get the package for your platform from the
[releases page](https://github.com/MohamedElashri/hbox-term/releases).

| Platform | Package |
|---|---|
| macOS Apple Silicon / Intel | `.dmg` for your architecture |
| Linux x86_64 / ARM64 | `.deb`, `.rpm` or `.AppImage` |

> [!NOTE]
> **macOS:** the app is not notarized, so macOS blocks a downloaded copy ("Ternway is damaged"
> or "cannot be opened"). After moving it to Applications, allow it with
> `xattr -dr com.apple.quarantine /Applications/Ternway.app`. The install script does this for you.

## Development

Requires Node.js, Rust and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

```sh
make dev      # run the app with hot reload
make test     # frontend and backend tests
make build    # release packages for this OS
make help     # list every target
```

See the [developer guide](DEVELOPER_GUIDE.md) for dependencies, architecture and releasing.

## License

[MIT](LICENSE). Bundles JetBrains Mono under the
[SIL Open Font License](licenses/JetBrainsMono-OFL.txt).

## Name change in 0.2

Ternway is the new display name. Existing installations keep the same application
identifier, profile database, credential vault, configuration directory
(`~/.config/hbox-term`), shell integration environment variables, and updater
trust key. The executable/package identifier remains `hbox-term` for compatibility.
The repository and update feed stay at their current GitHub addresses.

Open **Settings → About Ternway** for version/build details, project links, credits
and license information. On macOS, **Ternway → About Ternway** opens the same page.
