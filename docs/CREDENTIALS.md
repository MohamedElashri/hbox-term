# Password managers and terminal privacy

SSH keys use the standard SSH-agent protocol, including agents provided by 1Password,
Bitwarden or OpenSSH. Ternway never reads their private keys. Select an agent identity
with `env:SSH_AUTH_SOCK` or its absolute socket path. OpenSSH-linked connections use
OpenSSH's own authentication configuration.

For managed password connections, choose a password source in the connection editor:

- Local: ask when connecting, or save in the encrypted local vault.
- 1Password CLI: save an `op://vault/item/field` reference. Install `op` and sign in;
  desktop integration may request approval. Ternway calls `op read --no-newline`.
- Bitwarden CLI: save the login item's UUID. Install `bw`, sign in and unlock the CLI,
  then launch Ternway in the environment containing `BW_SESSION`. Ternway calls
  `bw get password UUID --raw --nointeraction`; it never asks for your Bitwarden master
  password. A desktop app alone does not establish that CLI session.

References are metadata. Saving, importing and duplicating them never retrieves a
password. Retrieval happens after host-key verification, at connection time, with
fixed arguments and no shell. Output is capped at 64 KiB, times out after 90 seconds,
and is cancelled with the connection. Stderr is discarded and errors are generic.
Secret buffers are zeroized when dropped. Retrieved passwords are never copied into
Ternway's vault, database, terminal input, command arguments or application logs.

Provider commands: [1Password read](https://developer.1password.com/docs/cli/reference/commands/read/),
[Bitwarden CLI](https://bitwarden.com/help/cli/).

## Locking

Settings → Connections → Lock now clears the decrypted local vault key/document and
session-only SSH passwords across windows. It leaves already authenticated sessions
running. Fresh authentication requires another unlock/password/provider approval.
The backend enforces a 15-minute inactivity timeout; mouse/keyboard activity in any
Ternway window refreshes it. Focus loss also locks and clears credential forms.

macOS additionally observes the distributed screen-lock notification; this notification
name is an OS convention, not a documented Apple compatibility guarantee. Linux polls
logind's [LockedHint](https://www.freedesktop.org/software/systemd/man/latest/org.freedesktop.login1.html)
every five seconds where available. Focus-loss locking remains the fallback for screen
lockers that do not publish this hint. Native lock/wake checks on each desktop remain
part of release QA; the app never locks your screen to run an automated test.

## Output and clipboard

`clipboard-history = false` and `save-scrollback = false` are the defaults. Set either
true in the terminal config to opt in. Clipboard history is memory-only, bounded to
25 entries of at most 64 Ki characters, expires after two minutes, and clears on lock.
Settings can clear clipboard history and stop/clear log viewers. It does not clear
the system clipboard or copies held by other applications. JavaScript cannot promise
physical memory zeroization.

Layouts retain pane metadata with saved scrollback disabled. Enabling it stores up to
1,000 lines per pane; output may contain secrets, as may raw remote logs and explicit
exports. There is no reliable general-purpose redaction of arbitrary terminal output.
These controls prevent new history; delete older saved layouts/backups separately if
they contain sensitive output. Vault locking does not hide live terminals or log viewers.

## Verification

Tests cover reference validation, exact password whitespace, provider error isolation,
output limits, deadlines/cancellation, encrypted-vault lock/unlock, shared transient
credential removal, inactivity timing and clipboard expiry/bounds. Live 1Password and
Bitwarden secret retrieval is **deferred at the user's request**; fixtures do not establish
account integration or signing-approval behavior. No live vault fields were read.
