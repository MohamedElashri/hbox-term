# hbox-term plan

hbox-term is a terminal workspace: SSH server management (vault, SFTP, Docker/Podman, services, logs,
tunnels, …) together with a local terminal good enough to replace Ghostty (Linux) and iTerm2 (macOS)
for daily development.

Platforms: **Linux and macOS only.** Windows is out of scope.

## Starting point

The initial codebase was a Tauri 2 app of ~16.7k lines:

- Rust backend (~9k lines): `ssh.rs`, `providers.rs`, `terminal.rs`, `storage.rs` (SQLite), `credentials.rs`
  (Argon2 + AES-GCM vault). SSH is libssh2 via the `ssh2` crate, one blocking thread per session.
- TypeScript frontend (~4.5k lines), no framework. 3.4k of it was `src/main.ts`, which re-renders views
  with `innerHTML`. The terminal was xterm.js 5 with the fit and serialize addons.

Weaknesses that mattered for a terminal-first app:

| Area | Initially | Fix |
|---|---|---|
| Output path | 12 ms poll loop, each chunk sent as a JSON string event | Blocking reader thread, binary `tauri::ipc::Channel`, coalesce to ~1 frame / 64 KB |
| Rendering | DOM renderer | `@xterm/addon-webgl`, DOM fallback |
| View switching | Terminal disposed and rebuilt from the serialize addon | Terminal DOM nodes live as long as the pane; hidden, never re-rendered |
| Frontend | One 3.4k-line file | Split into modules before adding features |
| Layout | Server → flat tab list | Workspace → tabs → split-pane tree |

## Architecture

### Session layer (Rust)

```
trait PtyBackend { fn write(&self, &[u8]); fn resize(&self, cols, rows); fn close(&self); }
  LocalPty   portable-pty (from wezterm): login shell, TERM=xterm-256color, COLORTERM=truecolor
  SshPty     existing ssh2 channel code, moved behind the trait
  ExecPty    existing docker/podman exec
```

All output goes to the frontend as raw bytes over one `ipc::Channel` per session. The frontend never knows
which backend it is talking to.

### Layout

Workspace → tabs → binary split tree. A pane holds **any view**: local shell, remote shell, SFTP browser,
log stream, Docker, stats. Server panels become pane types instead of full-screen pages, so a shell,
`journalctl -f` and an SFTP browser can sit side by side.

### Shell integration

Inject a small init script for zsh, bash and fish (like Ghostty's `shell-integration`), emitting:

- OSC 133 prompt/command/output marks → jump between prompts, per-command exit status and duration in the
  gutter, select/copy last output, notify when a long command finishes
- OSC 7 working directory → new split/tab opens in the same directory, cwd shown in the tab title
- OSC 2 title, OSC 52 clipboard (honouring `clipboard-read`/`clipboard-write`)

The same script can be offered for remote shells (opt-in, sourced from a temp file over the SSH channel).

### Config

Plain-text `~/.config/hbox-term/config` in **Ghostty's `key = value` syntax**, hot-reloaded. On first
run, import `~/.config/ghostty/config` when present. Supported keys at first: `font-family`, `font-size`,
`theme`, `palette`, `background`, `foreground`, `cursor-color`, `cursor-style`, `cursor-style-blink`,
`selection-*`, `copy-on-select`, `clipboard-*`, `scrollback-limit`, `wait-after-command`,
`shell-integration`, `keybind`. Unknown keys get a warning instead of an error. `theme = X` resolves
against Ghostty's bundled theme directory if present, then our own.

The settings UI edits this file; the file is the source of truth. Server profiles and secrets stay in
SQLite and the vault.

## Features

Taken from what Ghostty and iTerm2 do well, ordered by priority.

### P0: daily driver

- Local terminal: tabs, splits, zoom split, navigate splits, resize splits, all keyboard-driven
- Keybinding presets: **Ghostty defaults on Linux** (`ctrl+shift+t/w`, `ctrl+shift+o/e` split,
  `ctrl+alt+arrows`, `ctrl+shift+enter` zoom, `alt+1..9`), **iTerm2 defaults on macOS** (`cmd+d` /
  `cmd+shift+d`, `cmd+opt+arrows`, `cmd+shift+enter`, `cmd+1..9`). Fully rebindable via `keybind =`.
- WebGL rendering, truecolor, unicode11 widths, cursor styles, font size zoom per pane
- Scrollback search (`addon-search`) with highlights and regex
- Links: URLs, plus **file:line** paths, ctrl/cmd-click opens in `$EDITOR`, like iTerm2's semantic history
- Paste protection: confirm multi-line or unsafe pastes, bracketed paste, trim trailing spaces
- `wait-after-command`: keep the pane open after the process exits, show the exit code
- Open Quickly / command palette: fuzzy search over tabs, panes, servers, saved commands and actions
- Profiles: shell, cwd, env, font, theme; auto-switch profile on SSH host like iTerm2

### P1: what a plain terminal can't do

- Shell integration features (above): prompt jumps, exit status gutter, copy last output, cwd inheritance
- **Edit a remote file in your local editor**: SFTP download → watch → upload on save, with conflict check
- Drag and drop between local and SFTP panes
- One-click port forward from the listening-ports view (existing tunnel code)
- Broadcast input to selected panes
- Paste history and autocomplete from scrollback words (iTerm2's `cmd+shift+h` / `cmd+;`)
- Triggers: regex on output → highlight, notify or run an action
- Notification when a command running more than N seconds finishes in an unfocused pane
- Session restore: layout, cwd and scrollback snapshot (processes do not survive a restart)
- Quick terminal: global hotkey drops down a terminal (iTerm2 hotkey window / Ghostty quick terminal).
  macOS: global shortcut API. Linux: works on X11 and KDE; GNOME Wayland needs the
  `GlobalShortcuts` portal, otherwise users bind a desktop shortcut to `hbox-term --toggle-quick`.

### P2: later

- Inline images: `addon-image` supports **sixel and the iTerm2 image protocol** (`imgcat`). The kitty
  graphics protocol, which Ghostty supports, is not available in xterm.js.
- tmux control mode (`tmux -CC`), iTerm2-style native tabs for tmux windows
- asciinema recording
- Process persistence across restarts (needs a daemon; large)

## Known gaps versus Ghostty and iTerm2

Being upfront so they don't come as surprises:

- **Raw speed.** A webview terminal will not match Ghostty's native GPU renderer. The goal is "never feels
  slow", not winning benchmarks. On Linux Tauri uses WebKitGTK, which is slower than Chromium and has had
  unreliable WebGL. **M1 is a go/no-go gate on this.** If it fails, the fallback is keeping the webview for
  panels and rendering terminals natively with `alacritty_terminal`, which is a much larger project.
- **Font rendering** will look different from Ghostty on Linux (the webview does the text shaping).
- **Kitty keyboard protocol** (useful in neovim/helix) depends on xterm.js support. Check this when
  upgrading to xterm.js 6; if it's missing, it's a known gap.
- **Unlimited scrollback.** Your Ghostty config has `scrollback-limit = 4294967295`. xterm.js keeps
  scrollback in JS memory, so hbox-term keeps a large in-memory window (default 100k lines) and spills
  older output to a per-session file on disk that search can still reach.

## Performance budget

| Metric | Target |
|---|---|
| Launch to usable window | < 300 ms |
| Keypress to glyph | < 10 ms |
| `cat` 100 MB file | UI stays responsive, input still works |
| Idle RAM, one window, 4 panes | < 150 MB |
| Release binary | < 15 MB |

A `bench/` directory holds scripted throughput and latency tests run before every milestone.

## Size discipline

- Stay framework-free in the frontend. Small modules, a tiny event bus, no React/Vue.
- New Rust deps limited to `portable-pty`, `notify`, and a small config parser. New npm deps limited to
  xterm addons (`webgl`, `search`, `web-links`, `unicode11`, `image`).
- Budget: about +6–8k lines total for everything in P0 and P1.

## Identity

- Crate `hbox-term`, bundle ID `dev.elashri.hbox-term`, data files `hbox-term.sqlite3` and
  `hbox-term.credentials`; remote-side markers and temporary files use the `hbox-term` name.
- MIT license; attribution for the original code is in LICENSE.

## Milestones

1. **M0, foundation:** done, pending a manual run with a real SSH session.
   - Rename; Windows dropped from CI and the `openssl-on-win32` feature.
   - `main.ts` (3.4k lines) split into `src/app/` modules: `state.ts` holds all mutable state in one
     `AppState` instance; `views/` render, `actions/` talk to the backend, `events.ts` dispatches DOM events.
   - `pty_output.rs`: binary `ipc::Channel` output, batched to one message per 8 ms frame while
     streaming, with ack-based flow control (reading pauses above 4 MiB unacknowledged). Unit tested.
   - SSH loop no longer sleeps 12 ms after every 16 KiB read (which capped output near 1.3 MB/s) and
     wakes immediately on input instead of finishing its sleep.
   - xterm.js 6 with WebGL (DOM fallback) and unicode11; one long-lived xterm per tab, moved between
     renders instead of disposed and rebuilt from serialized text.
   - Found: xterm.js 6.0 has no kitty keyboard protocol.
   - Still to do: waiting for socket readability instead of polling every 1–12 ms when idle (needs access to
     the session socket, or a move to `russh`).
2. **M1, local terminal + gate:**
   - Done: `local_pty.rs` (login shell on a PTY, hang-up on close so history is saved), the Local
     workspace that opens on launch, the Dracula rebrand, and the fixed terminal layer (terminals are
     never moved in the DOM, which fixed stale WebGL frames in WebKitGTK).
   - Done: split panes (`src/app/panes.ts`: tree, layout, directional focus; draggable dividers,
     zoom, dimmed unfocused panes, "press any key to close" after exit), keybindings in Ghostty's
     `trigger=action` syntax with Ghostty (Linux) and iTerm2 (macOS) defaults, clipboard with paste
     protection, per-pane font size, `bench/throughput.sh`, and `npm test` (node --test + cargo test).
   - Found: in WebKitGTK (tested with software GL), resized WebGL terminals were not repainted.
     Linux defaults to the DOM renderer; Settings → Terminal renderer switches to WebGL to test it
     on real hardware.
   - Result (2026-10-25): **go, staying on xterm.js.** `bench/throughput.sh` gives ~23 MB/s on
     Linux. Measuring each stage showed the limit is xterm.js parsing in WebKitGTK's JavaScript
     engine (17–20 MB/s with either renderer), not IPC (Tauri raw channel ~200 MB/s, a local
     WebSocket ~450 MB/s). That is far above build and log output; only `cat` of huge files or
     log floods are noticeably slower than Ghostty, and flow control keeps Ctrl+C responsive.
     Typing feel is judged in daily use.
   - Fallback if real use shows it matters: a native terminal core (below, M5).
3. **M2, comfort:**
   - Done: config file in Ghostty's format (`src-tauri/src/config.rs` reads, follows `config-file`
     includes, finds theme files and watches them; `src/app/config.ts` interprets keys). A new config
     includes the Ghostty config instead of copying it. Live reload, Settings section with errors and
     ignored keys, `keybind` overrides (`clear`, `unbind`). Scrollback search with highlighted matches.
     Command palette over actions, tabs in every workspace, servers and app actions.
   - Done: profiles as Ghostty-format files in `profiles/`, layered on the main config, with
     `command`, `working-directory`, `env` and hbox-term's `match-host` (SSH tabs to matching servers
     use the profile); opened from the command palette. JetBrains Mono bundled (OFL).
4. **M3, integration:**
   - Done: shell integration for local zsh (ZDOTDIR), fish (XDG_DATA_DIRS) and bash (source line):
     OSC 133 marks with an exit-status gutter and ruler, jump between prompts, copy last output,
     OSC 7 directories inherited by new tabs and splits, live tab titles, notify-on-command-finish.
   - Done: remote files edited in the local editor (`remote_edit.rs`: private temp copy, upload on
     save, conflict check against the remote mtime/size, cleanup on exit). Session restore of local
     tabs: layout, directories, profiles and 1,000 lines of scrollback per pane; restored shells
     start when their pane is first shown, at its real size.
   - Also done before M4: links (URLs and existing `file:line` paths, Ctrl/Cmd+click, opening in
     the editor via `editor.rs`), saved commands in the palette, dropping files on panes (paths into
     local shells, uploads to SSH panes), one-click port forwarding from listening ports.
5. **M4:** done. Inline images (sixel and iTerm2's protocol; the CSP allows WebAssembly, which
   the image decoder needs), broadcast input per tab, paste history and autocomplete from the
   pane's output (from iTerm2), triggers (highlight, notify, mark), and the quick terminal: a
   second window toggled by a global hotkey (`keybind = global:…`) or `hbox-term --toggle-quick`
   through the single-instance plugin, for desktops without global hotkeys such as GNOME on Wayland.
   - After M4: a terminal tab strip (rename, reorder, close), a terminal dock beside server views
     (`Ctrl+\``), and opt-in remote shell integration installed over SFTP; local bash integration is
     now automatic.
6. **M5, only if needed:** native terminal core. Parse with `alacritty_terminal` in Rust and send
   changed rows per frame to a small renderer, so throughput depends on frame rate rather than
   bytes. Costs reimplementing selection, scrollback, links, search, mouse reporting and IME.
