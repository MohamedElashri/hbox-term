# Changelog

## 0.2.0-beta.1 - 2026-11-05

Preview release of Ternway (formerly hbox-term), with a redesigned connection library and SSH-agent identities.

### Ternway identity

- New display name, folded-wing logo, application icons and release artwork.
- Branded About page with runtime version/platform details, credits, license, project links and copyable build details.
- Existing identifiers, data/configuration paths, repository and updater trust stay compatible.
- Branded release assets and beta updater manifests, with legacy asset-name support.

### Connection library

- Persistent connection sidebar with search and a clearer connection form.
- Import selected SSH config aliases into a saved group, with included-file and common-default support.
- Collapsible groups with connection counts, remembered expansion state, and rename/move controls.
- Existing-group suggestions and a Settings icon distinct from the appearance toggle.
- Capability-aware navigation and improved Escape behavior in custom selectors.
- Bash command markers work with macOS system Bash 3.2 as well as modern Bash, with prompt hooks excluded.

### SSH identities and storage

- Reusable SSH-agent identities using the standard protocol on macOS and Linux, with a system SSH_AUTH_SOCK selector or explicit socket path.
- Provider-neutral connection/signing flow; password-manager shortcuts only discover sockets.
- Isolated OpenSSH-agent regression for key enumeration and sign/verify, plus a generic opt-in live SSH test.
- 1Password socket discovery and an agent key-availability check.
- SQLite identity migration with a pre-migration backup, transactional connection bindings, and referenced-identity protection.
- Agent-only authentication without copying private keys or requiring a local credential vault.
- Detailed agent authentication errors and a fix for closed agent sockets causing an indefinite receive loop.
- Patched bundled libssh2 to prevent failed agent connections from double-closing a reused file descriptor.

### Validation

- 69 frontend tests and 42 Rust tests passed on macOS; three live-only tests are excluded from the normal suite.
- Authorized read-only SSH authentication through 1Password passed using the production client in the test executable.
- Native macOS QA verified import, group rename/collapse, connection saving, local terminal output, and distinct icons.
- Added a macOS/Linux CI matrix and an isolated, ad-hoc-signed macOS QA build target.

### Known limitations

- **Packaged macOS 1Password signing is unresolved.** Native attempts can stall waiting for the agent signing response; a passing test-executable login does not establish packaged-app compatibility.
- Linux runtime/password-manager verification and Bitwarden live verification remain pending.
- SSH config import supports a subset of OpenSSH configuration. Match rules, ProxyJump/ProxyCommand, full token expansion, and Include globs in directory components are not imported; review routing before connecting.
- Agent signing has no cancellation deadline while an agent keeps its socket open. Per-key selection and password retrieval from provider vaults are not implemented.
- This prerelease is prepared as a draft; distributable bundles and updater artifacts are pending the release build.

## 0.1.0 - 2026-10-25

First release, for Linux (x86_64, ARM64) and macOS (Apple Silicon, Intel).

### Terminal

- Opens into your login shell on a local PTY, with tabs, splits, pane zoom and a tab strip you
  can reorder, rename and close with the middle button.
- Ghostty's keybindings on Linux and iTerm2's on macOS, changeable with `keybind =` lines.
- Configuration in Ghostty's format (`~/.config/hbox-term/config`), which includes your Ghostty
  config, reloads on save and supports profiles, including per-host profiles for SSH tabs.
- Shell integration for zsh, bash and fish, locally and over SSH: exit status marks, prompt
  jumping, copying the last command's output, new panes in the current directory, and
  notifications when long commands finish.
- Quick (drop-down) terminal with a global hotkey or `hbox-term --toggle-quick`.
- Clickable URLs and `file:line` paths that open in your editor, inline images (sixel and iTerm2),
  triggers, broadcast input, paste history, completion from pane output, and session restore.
- Dracula and Alucard themes and bundled JetBrains Mono.

### Servers

- SSH with passwords, keys, SSH config import and jump hosts; host keys checked against
  `known_hosts`; secrets kept in an encrypted vault behind a master password.
- System overview, processes, systemd services, logs, ports, files over SFTP, disk usage, Docker
  and Podman, Compose, cron, packages, users, SSH keys, firewall rules and SSH tunnels.
- Server terminals docked beside the other views, and remote files edited in your local editor.

### Updates

- Settings → Updates (or "Check for updates" in the command palette) checks GitHub when you ask,
  shows the release notes, and installs a signed update with one click. AppImage, `.deb`, `.rpm`
  and macOS installs update in place.
- `install.sh` installs the right package for your system and verifies its checksum.
