# Ternway user guide

## What it does

- Opens a local shell on launch: your login shell on a real PTY, with xterm.js and WebGL rendering.
- Connects to servers with password or private-key authentication, including SSH config import and
  bastion (ProxyJump-style) routes.
- Stores passwords, key passphrases and sudo credentials in an encrypted local vault protected by a
  master password.
- Verifies SSH host keys against `known_hosts`, showing fingerprints before trusting a new or changed key.
- Shows CPU, memory, disks, network interfaces, uptime and load.
- Manages processes, systemd services, logs, listening ports and active connections.
- Browses and edits files over SFTP, including uploads, downloads, permissions, ownership and
  recursive transfers.
- Explores disk usage, inode pressure, large files and directories, Docker storage and `/var/log`.
- Works with Docker and Podman containers, images, volumes, networks, logs, statistics and exec shells,
  and with Docker Compose projects.
- Manages crontabs, APT packages, users and groups, SSH authorized keys, and UFW or firewalld rules.
- Saves commands, keeps local server notes, and runs local, remote or SOCKS5 SSH tunnels.

Remote features detect what each server supports instead of assuming a distribution or init system.

## Keybindings

Ghostty's defaults on Linux and iTerm2's on macOS. Every other key goes to the shell.

| Action | Linux | macOS |
|---|---|---|
| Copy / paste | Ctrl+Shift+C / Ctrl+Shift+V | Cmd+C / Cmd+V |
| New tab | Ctrl+Shift+T | Cmd+T |
| Close pane | Ctrl+Shift+W | Cmd+W |
| Split right / down | Ctrl+Shift+O / Ctrl+Shift+E | Cmd+D / Cmd+Shift+D |
| Move between panes | Ctrl+Alt+Arrows | Cmd+Option+Arrows |
| Zoom pane | Ctrl+Shift+Enter | Cmd+Shift+Enter |
| Next / previous tab | Ctrl+Tab / Ctrl+Shift+Tab, Ctrl+PgDn / Ctrl+PgUp | Cmd+Shift+] / Cmd+Shift+[ |
| Go to tab 1–8, last | Alt+1…8, Alt+9 | Cmd+1…8, Cmd+9 |
| Font size | Ctrl+= / Ctrl+- / Ctrl+0 | Cmd+= / Cmd+- / Cmd+0 |
| Select all | Ctrl+Shift+A | Cmd+A |
| Clear | | Cmd+K |
| Find in scrollback | Ctrl+Shift+F | Cmd+F |
| Command palette | Ctrl+Shift+P | Cmd+Shift+P, Cmd+Shift+O |
| Reload config | Ctrl+Shift+, | Cmd+Shift+, |
| Previous / next prompt | Ctrl+Shift+PgUp / Ctrl+Shift+PgDn | Cmd+Shift+↑ / Cmd+Shift+↓ |
| Copy last command's output | (palette) | Cmd+Shift+A |
| Broadcast input to all panes of the tab | Ctrl+Shift+Alt+I | Cmd+Option+I |
| Paste history | Ctrl+Shift+H | Cmd+Shift+H |
| Complete word from the pane's output | Ctrl+Shift+; | Cmd+; |

Pasting text with line breaks asks first unless the program enabled bracketed paste.

Ctrl+click (Cmd+click on macOS) opens URLs, and file paths printed in local panes, such as
`src/main.rs:12:5` from a compiler, in your editor at that line: terminal editors in a split, GUI
editors (VS Code, Zed, …) in their own window. Only paths that exist become links.

Dropping files on a local pane types their quoted paths; dropping them on an SSH pane uploads them
to that pane's directory (or the home directory) after asking. In a server's Network view, the
button on a listening TCP port forwards it to `localhost` in one click. Saved commands appear in the
command palette and are typed into the focused pane for you to run.
Bindings can be changed with `keybind =` lines in the config.

## Terminals beside server views

In a server's Files, Logs, Docker or any other view, `Ctrl+\`` (or the **Terminal** button in the
page header) docks that server's terminals beside the view, on the right or at the bottom, with
their tabs and splits. Drag the divider to resize. Views keep one set of state per server, so one
view at a time shares the screen with the terminals.

## Quick terminal

A drop-down terminal (Ghostty's quick terminal, iTerm2's hotkey window) with local shells. Give it
a global hotkey in the config, as in Ghostty:

```
keybind = global:super+grave_accent=toggle_quick_terminal
quick-terminal-position = top        # bottom, left, right, center
quick-terminal-size = 40%            # or 40%,1200px or 600px
quick-terminal-autohide = true       # hide when it loses focus
```

GNOME on Wayland does not let apps grab global keys (and ignores window positions). There, add a
custom shortcut in Settings → Keyboard that runs `ternway --toggle-quick`; that also works on
every other desktop. Closing the main window quits Ternway, quick terminal included.

## Triggers and inline images

Triggers (from iTerm2) act on output lines that match a regular expression:

```
trigger = highlight:#ff5555 /error|failed/i     # color the match
trigger = notify:Build finished /^Finished/     # desktop notification
trigger = mark /WARN/                           # mark in the scrollbar
```

Inline images work with sixel and iTerm2's protocol (`imgcat`); `image-storage-limit` (bytes, as in
Ghostty, `0` turns them off) caps their memory. Ghostty's kitty graphics protocol is not supported.

## Shell integration

Local zsh, bash and fish shells get integration automatically: zsh through a temporary `ZDOTDIR`
that then restores yours, bash through an rcfile that does what a login shell does (`/etc/profile`
and your first profile file) and then loads the integration, fish through `XDG_DATA_DIRS`. It marks
prompts and commands (OSC 133) and reports the working directory (OSC 7), which gives:

- a green or red mark next to each prompt for the command's exit status, also in the scrollbar
- jumping between prompts and copying the last command's output
- new tabs and splits that open in the focused pane's directory (`working-directory = inherit`)
- tab names that follow the running command or directory
- a desktop notification when a long command finishes, with `notify-on-command-finish = unfocused`
  (or `always`) and `notify-on-command-finish-after = 10s`

SSH sessions get the same with `remote-shell-integration = true`. Ternway then installs the
scripts on each server once per version, in `~/.cache/ternway/shell-integration/` (over SFTP),
and starts your login shell through them; SSH splits and tabs open in the remote directory. Without
SFTP the shell starts as usual.

Set `shell-integration = none` to turn it off. Shells already integrated for Ghostty, iTerm2 or
VS Code emit the same sequences and work too.

## Editing remote files locally

In a server's Files view, the terminal button on a file opens it in your editor in a local pane
(`$VISUAL`/`$EDITOR` from your login shell, or `editor = …` in the config, e.g. `editor = code --wait`).
Every save is uploaded with the same atomic write as the built-in editor. If the file changed on
the server since you opened it, Ternway asks before overwriting. The local copy lives in a
private temporary directory and is removed when the editor exits.

## Updates

Settings → **Updates**, or "Check for updates" in the command palette, asks GitHub for the latest
release. Ternway never checks on its own. When a newer version exists it shows the release
notes; **Install update** downloads it, verifies its signature and installs it, and **Restart
now** starts the new version. Restarting ends the programs running in your terminals.

AppImage, `.deb`, `.rpm` and macOS installs update in place; for `.deb` and `.rpm` your system asks
for your password. Builds from source show a link to the releases page instead.

## Session restore

Local tabs come back after a restart: layout, each pane's directory (with shell integration) and
profile, and up to 1,000 lines of scrollback per pane. Full-screen programs and server tabs are
not restored. Set `window-save-state = never` to turn it off.

## Configuration

Terminal settings live in `~/.config/ternway/config`, in
[Ghostty's config format](https://ghostty.org/docs/config). The file is created on first run and
includes your Ghostty config with `config-file = ?~/.config/ghostty/config`, so what you set for
Ghostty applies here too; lines after the include override it for Ternway. Changes apply when
the file is saved. Settings shows the file, any errors, and the Ghostty keys Ternway ignores.

Supported so far: `font-family`, `font-size`, `theme` (including `light:…,dark:…`, resolved from
Ghostty's theme directories), `background`, `foreground`, `palette`, `cursor-color`, `cursor-text`,
`selection-background`, `selection-foreground`, `cursor-style`, `cursor-style-blink`,
`copy-on-select`, `clipboard-paste-protection`, `clipboard-paste-bracketed-safe`,
`clipboard-trim-trailing-spaces`, `scrollback-limit`, `wait-after-command`, `keybind`,
`config-file`, `command`, `working-directory`, `env`, `shell-integration`,
`notify-on-command-finish`, `notify-on-command-finish-after`, `window-save-state`,
`image-storage-limit`, `quick-terminal-position`, `quick-terminal-size`, `quick-terminal-autohide`
and `keybind = global:…`, plus Ternway's own `editor`, `trigger` and (in profiles) `match-host`.

**Profiles** are files in `~/.config/ternway/profiles/`, in the same format, layered on top of the
main config. Open one with "New tab: <name>" in the command palette. A profile with
`match-host = prod-*` is used for SSH tabs to servers whose host or name matches, for example to
give production a different background:

```
# ~/.config/ternway/profiles/prod
match-host = prod-*
background = 3a1418
```

## Safety and privacy

Ternway runs on your computer and talks to servers over SSH only. Secrets are encrypted locally.
Disruptive operations such as firewall changes, account deletion or service actions ask for
confirmation first; keep an independent recovery path before changing remote access or critical services.

## About Ternway

Open Settings → About Ternway to view the version, platform, credits and license,
or copy build details when reporting an issue. Copied details contain only the
version, OS/architecture, build type and source commit.

## SSH agents

In Settings → SSH identities, the default endpoint is `env:SSH_AUTH_SOCK`.
Ternway resolves it from the application's environment each time it connects.
Use an absolute socket path (or `~/…`) when selecting a different agent or when
a desktop launch does not inherit SSH_AUTH_SOCK. The UI explains when the
environment variable is unavailable.

All endpoints use the same standard SSH-agent client for key enumeration and
authentication signing. OpenSSH and compatible password-manager agents share
this path. The agent controls access to its keys and any signing approval.
The optional 1Password shortcut only finds a socket; it does not select a
different signing implementation.

For an explicitly authorized live check against your own test host, run:

```sh
TERNWAY_TEST_SSH_HOST=your-test-host TERNWAY_TEST_SSH_USER=your-test-user TERNWAY_TEST_SSH_AGENT_SOCKET=/absolute/path/to/agent.sock cargo test --manifest-path src-tauri/Cargo.toml --lib live_agent_login_and_read_only_command -- --ignored
```

TERNWAY_TEST_SSH_PORT is optional (default 22). If the agent socket override is
omitted, the test uses SSH_AUTH_SOCK. The check enforces known_hosts, runs a fixed
read-only printf command, disconnects and removes its temporary profile store.
A separate opt-in 1Password regression remains available. Protocol support does
not guarantee support for every provider policy, key type or agent extension.
