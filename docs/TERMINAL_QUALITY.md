# Terminal behavior and checks

Composition events, legacy IME key events and AltGr pass to text entry without triggering
application shortcuts. This applies to terminals, forms and the command palette.
On macOS, Option keeps its native character/dead-key behavior by default. Set
`macos-option-as-alt = true` to send Option as Meta, or `false` for native characters.
Per-side Option preferences are not supported yet.

Closing a pane, tab, server workspace or window checks running sessions first. Local checks
inspect the terminal’s foreground process group, its child processes and the executable name
without reading command arguments or typing into the shell. SSH sessions receive a disconnect
warning because remote job activity cannot be reliably inspected. If inspection fails, Ternway
asks before closing. `confirm-close-surface = false` explicitly disables these warnings for a
profile. Quit checks windows one at a time so a second window cannot hide the first prompt.
These checks are advisory snapshots; save editor changes before closing.

Automated coverage includes byte-by-byte UTF-8 input, combining characters, CJK/emoji widths,
full-screen alternate buffers, 100 consecutive resizes, more than six megabytes of PTY output,
background/foreground jobs, `exec` replacing a shell, and closing a reader paused by backpressure.
The local output event queue is bounded as well as the webview acknowledgement buffer.
macOS and Linux CI run these fixtures. Actual input methods, keyboard layouts and GPU drivers
still require native checks on the target desktop.
