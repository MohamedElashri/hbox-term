# Workspaces and windows

Open **Workspaces** in the tab bar to save this window’s connections, terminal tabs and split
layout under a project name. **Open in new window** restores that layout without disturbing
current sessions. **New window** opens an independent window; Command-N on macOS and
Ctrl-Shift-N on Linux do the same.

Restored panes are idle. Their output is historical, and **Start session** opens a fresh
shell or SSH session only when requested. Layouts never store or replay commands, typed input
or credentials. Starting a session can run the shell’s normal startup files or OpenSSH’s
configured login hooks. Server-side tools such as tmux are needed for processes that must
survive disconnects or application restarts.

Ordinary windows save their layouts separately. Quit saves every window before exiting and
reopens those windows on the next normal launch. Closing one window closes only its terminal
panes; other windows continue running. The quick terminal alone does not restore ordinary
windows. Disabling automatic session saving also excludes extra windows from startup restoration.
Named layouts can still be opened explicitly.

Layouts reference saved connection IDs. Deleted connections are skipped during restoration.
Version 1 local layouts migrate to the idle restore behavior. Unsupported or damaged layouts
are reported and kept for recovery. Layout trees, file sizes and file names are validated;
layout files use owner-only permissions. Saved history may contain sensitive terminal output;
keep the application data directory private.
