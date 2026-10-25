# Changelog

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
