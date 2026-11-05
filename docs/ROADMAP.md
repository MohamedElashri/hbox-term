# Daily-use terminal and SSH manager

Each numbered stage starts from current main, is tested and reviewed in its own PR, and is
merged before the next starts. PR bodies contain only a short “This PR is …” description.
The preceding QA/password fixes and native OpenSSH support are merged in #6 and #8.

1. **Shared SSH handling — merged in #9.** Share OpenSSH routing/authentication across terminals,
   SFTP and tunnels, with private app-owned connection control and explicit ownership cleanup.
2. **Lifecycle and recovery — in progress.** Accurate connection states, interruption handling,
   safe cancel/reconnect and sleep/network recovery without command replay.
3. **Workspaces — pending.** Named layouts, ordinary windows and local/remote workspace restore;
   restoring a layout must not imply resuming a process or running remote commands.
4. **Terminal quality — pending.** Keyboard/IME/Unicode/full-screen-app coverage, resize/output
   stress and protection when closing active jobs.
5. **Credentials — pending.** External credential references, provider flows and live verification,
   manual/idle/screen locking and clipboard/scrollback/log privacy controls.
6. **Library, transfers and portability — pending.** Deduplicated imports, source reconciliation,
   bulk editing, resumable queued transfers and versioned backup/restore with explicit secrets.
7. **Release confidence — pending.** Native GUI and platform coverage, soak/update recovery,
   properly signed/notarized macOS artifacts and documented release gates.
