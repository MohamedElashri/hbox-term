# Library, transfers and recovery

Settings → Connections → Manage library provides bulk group, tag and favorite editing,
portable library backup/restore and abandoned remote-edit recovery. The command palette
also opens the library and transfer queue. Bulk metadata changes are transactional: if
any selected connection disappeared, none are changed.

## SSH config import

Repeated imports match source path, alias and connection mode and reuse the same entry.
Identical existing profiles are adopted instead of duplicated. Reading a source reports
previous imports and aliases missing from the current file; missing aliases are kept.
"Update routing and authentication of existing imports" is opt-in and applies only to
selected aliases, preserving names, groups, tags, notes and favorites. Changed routes
invalidate the affected live connection and dependents. Import never connects or reads
external passwords. Each imported entry is saved independently; an error reports the
number processed so the remaining selection can be retried safely.

OpenSSH-linked entries resolve their source configuration at connection time. Managed
copies require explicit reconciliation to incorporate supported config changes.

## Transfer queue

Uploads/downloads enqueue durable intent and run serially. The queue is shared across
windows. Resume/retry is explicit after restart; startup never connects to remote hosts.
Pause cancels the current operation and retains a file checkpoint. Open Transfer queue
from Settings or the command palette to review errors, retry/resume, confirm replacement,
or run queued jobs. Removing history leaves partial files for recovery.

Regular files resume by comparing **every byte** in the checkpoint against the current
source before appending at its offset. Oversized, changed or non-regular checkpoints
fail safely. The source size/modification time is checked again before committing. A
retry uses the current source when its prefix still matches; there is no promise of a
snapshot of a file that other processes keep modifying. Linked profiles use current
OpenSSH config, as they do for terminal connections.

Uploads use a hidden `.NAME.ternway-upload-JOB-ID.part` beside the destination. Downloads
use `.ternway-download-JOB-ID.part` beside the local target. Upload checkpoints remain
on the server when offline; download checkpoints remain local. Folder retries rescan and
recheck conflicts; folder downloads restart their private staging tree, while individual
files support byte resume. Completed folder-upload files require explicit replacement
approval on retry. Source and destination paths are shown before retry.

Connection routing changes or a restored library invalidate old jobs: create a fresh
transfer after reviewing the destination. Library restore requires running transfers to
be paused and active remote-file editors to be closed. Recovery uploads also reject
changed connection routing; keep the local copy and review a manual upload destination. Pending transfers and running tunnels are included in Quit/disconnect warnings.

Final downloads use atomic no-replace rename on macOS/Linux. Upload replacement uses
server-supported rename without deleting the original first. A server lacking safe
replacement returns an error and keeps the original. There is no unlink-and-rename
fallback. Concurrent remote writes cannot be coordinated across arbitrary SFTP servers.

## Remote editor recovery

Local copies live in a private `remote-edits/UUID/file/` directory inside app data,
with recovery metadata. Saves retain the existing remote-version conflict check. Final
save waits for its result; failures, conflicts and missing files never delete the local
copy. Closing a pane waits for this save. Window/Quit preflight flushes without deleting
copies that a live editor might still write; failed flushes prevent normal close.

After a crash, Manage library lists abandoned copies with their local paths and offers
a safe upload retry. Conflicts retain the file rather than overwriting another change.
An active editor's conflict prompt remains explicit. Force-closing the process can lose
unsaved editor memory, but already-written local copies remain recoverable. Successful
final saves remove their private copy; failed copies remain until safely recovered.

## Portable backup

The version-1 `ternway-library` JSON archive contains typed data for connections,
identities, groups/tags/notes, saved commands, tunnels and import provenance. It never
contains executable SQL. Size is limited to 16 MiB / 25,000 records. Metadata may itself
be sensitive, particularly notes and saved commands; files are written owner-only.

"Include encrypted saved credentials" is **unchecked by default**. Enabling it includes
the existing authenticated-encryption vault ciphertext, never decrypted passwords or
transient credentials. Unlock the restored vault with its original master password.
External-manager references remain references, with no provider reads. Local key/socket/
config paths may need editing on a different machine. Terminal output, workspace layouts
and local terminal configuration are excluded; this is a library backup.

Restore previews counts and secret inclusion, then asks before replacing the current
library/vault and disconnecting remote activity. A checksum rejects changes since preview.
Invalid schemas/fields/references fail inside a database transaction before persistent
replacement. An automatic full library/ciphertext backup is written under app-data
`backups/before-restore-UUID.json`. A journal selects the vault matching the committed
SQLite transaction after an interrupted restore. Metadata-only restore removes current
saved credentials, keeping their ciphertext in that automatic backup. Restore does not
start sessions, tunnels, saved commands or external providers.
