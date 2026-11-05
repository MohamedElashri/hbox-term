# Workspace redesign

Target macOS and Linux. Keep application IDs and existing data locations stable during the redesign. Waypost is a provisional name, not a packaging migration.

## Delivery sequence

1. Application shell and connections (in progress): persistent searchable library, Terminal and Files first, keyboard-accessible contextual tools, progressive connection form, visual review on both desktop platforms.
2. Identities and storage: reusable identity references; versioned SQLite migration with backup and rollback tests; provider resolution for system agents, 1Password and Bitwarden. Distinguish SSH signing from vault password retrieval. Resolve secrets only when needed, never persist external secrets in workspace records.
3. Workspaces and targets: named local/remote layouts, restore layout without replaying commands, file transfers, additional target adapters, explicit backup/export options.

## Design direction

System UI type for controls and JetBrains Mono for terminals. Slate surfaces (#18222e, #202b38), blue accent (#8bbcff), light surfaces (#f2f5f8, #ffffff), and readable ink (#1f1f1f). Left-aligned connection names stay visible. Working terminal content gets the largest surface. Avoid hover-dependent discovery.

## Validation gates

Run TypeScript/build, frontend behavior tests, Rust checks and library tests on macOS and Linux in CI. Capability tests must distinguish the remote host from the desktop OS. Before completing the shell stage, visually verify both themes, compact widths, keyboard navigation, local shell input, SSH reconnect, split resizing and terminal/file docking on native builds. CI compilation alone does not establish native interaction quality.

Before identity migration ships, test existing databases, failed migrations, missing/locked providers, identity deletion with references, and secret-free exports. Provider integration requires real native testing; do not label placeholder controls as working integrations.

## Connection form increment

Host, username and authentication remain visible. Display name falls back to the hostname. Port/jump-host and organization controls use native expandable sections; existing non-default settings start expanded. Both save paths validate input before invoking the backend. Blank secret fields on edits remain omitted from the save payload, preserving vault values. SSH-config imports reveal a non-default port and clear stale custom key paths when selecting a detected key.

Validation: frontend draft tests cover defaults, input rejection, secret preservation, paths on both platforms, and organization/routing round trips. Native visual and interaction checks remain outstanding.

## Identity storage foundation

Schema version 2 adds secret-free identity metadata and a separate connection-to-identity reference table. A SQLite `VACUUM INTO` backup (`*.pre-identities.sqlite`) precedes the transactional migration. Existing server rows and encrypted vault bytes remain unchanged; no identity assignments are inferred. An identity can be referenced by several connections and cannot be deleted while referenced. Deleting a connection removes only its reference.

The storage model distinguishes local-vault references from SSH-agent sockets. These are storage categories, not completed provider integrations. The repository APIs are not exposed through IPC or the connection form yet. Next: implement runtime identity resolution and agent signing, then expose identity management and selection together. Vault password retrieval from 1Password/Bitwarden is a separate later adapter. Never advertise a provider as connected until runtime resolution exists.

Tests cover migration/reopen, rollback, future-version rejection, profile and vault preservation, reusable references, deletion constraints and required metadata. Recovery from the backup is manual while the app is closed; a user-facing restore flow is still pending.

## SSH-agent runtime and identity UI

Settings → SSH identities creates named, reusable agent identities with a username and explicit socket path. The connection form's SSH agent option selects an identity; the backend resolves its username and socket and signs through libssh2's per-session agent API. It never changes SSH_AUTH_SOCK or reads the agent's private keys. Failed/missing identities do not fall back to saved passwords. Local-vault identities remain unsupported at runtime.

Identities are immutable in this increment: create a replacement and reassign connections to change credentials. Referenced identities cannot be deleted. Assignment changes participate in the connection cache key and existing connection invalidation flow. Profile and identity-reference updates share a SQLite transaction. Existing password/private-key profiles keep their prior authentication path.

Socket configuration supports standard Unix agents on macOS/Linux, including password-manager agents configured by the user. There is no provider auto-discovery or vault-password retrieval. Native 1Password/Bitwarden approval dialogs and live SSH signing still require end-to-end verification with those applications; unit tests do not establish provider compatibility. Agents with many keys may hit the server's authentication-attempt limit; per-key selection remains future work.

## Live 1Password verification

The identity screen now offers **Find 1Password agent** and **Check agent**. Discovery checks standard Unix socket locations; availability uses the same libssh2 setup as authentication and reports only the number of public keys. It does not claim that listing keys proves signing approval or remote authentication.

Verified on the development Mac with user authorization:

- The running 1Password agent exposes four public keys through OpenSSH.
- A local `ssh-add -T` sign-and-verify challenge succeeded after approval, without exporting a private key.
- The application libssh2 client enumerated the same four keys through its production agent helper.
- The production SSH client authenticated to the authorized test host on its user-specified port after the user verified its first-contact fingerprint. The test checked the stored host key, authenticated through 1Password, ran a fixed read-only printf command, and disconnected successfully. Temporary profile storage was removed and no credential vault was created.

Two explicitly ignored live tests are available: `onepassword_agent_exposes_keys_through_application_client` and `live_onepassword_login_and_read_only_command`. Run them only with user authorization. The latter requires `HBOX_TEST_SSH_HOST`, `HBOX_TEST_SSH_USER`, and optionally `HBOX_TEST_SSH_PORT`; it uses temporary profile storage, enforces the existing known_hosts policy, runs a fixed printf command, disconnects, and removes temporary storage. For first contact only, `HBOX_TEST_ACCEPT_HOST_FINGERPRINT` may be supplied after explicit user verification of the exact fingerprint; the production trust path rechecks it before appending to known_hosts. Subsequent runs omit this variable. Never disable host-key checks to make this test pass. Packaged-app approval attribution, native UI interaction, Linux provider testing, and vault-password retrieval remain separate validation work.

## Native macOS QA pass

Built a separate `hbox-term QA.app` (`dev.elashri.hbox-term.qa`) so test identities and connections use a separate database. Native checks confirmed first launch, local terminal output, 1Password socket discovery with four available public keys, identity creation, and saving the authorized SSH target with a custom port. The QA app uses the user's normal SSH known_hosts and terminal configuration; it does not isolate those files.

Native testing exposed two defects:

- Escape in a custom picker reached the window's capture-phase handler and dismissed the connection form. The capture handler now dismisses an open picker first and restores focus to its trigger.
- The bundled libssh2 agent receive loop does not terminate on a zero-byte read. A Unix receive callback preserves libssh2's errno convention but maps EOF to ECONNRESET. This prevents a closed agent socket from spinning indefinitely; it does not add a deadline for an agent that keeps the socket open. Tests exercise data, nonblocking reads, and a fake agent that closes immediately after receiving a request. The callback is installed only for sessions using the agent helper, preserves session locking, and stores no user data.

The ordinary suite passes 35 Rust and 62 frontend tests. The read-only live 1Password SSH test still passes after the callback change. Packaged-app SSH, remote terminal and SFTP verification must be recorded separately from test-executable authentication; earlier native attempts stalled at agent signing or timed out during handshake. No password-manager security settings were changed.

Final native observations: the Escape fix was confirmed in the rebuilt UI (picker closes, form and focus remain). The QA bundle initially failed `codesign --verify --deep --strict`; explicitly sealing it with a local ad-hoc signature made verification pass. `make qa-macos` now reproduces this isolated signed build. This is not Developer ID signing or notarization and does not change production release signing.

Even with a valid local bundle signature, the native app did not show a 1Password approval and did not complete authentication. A previous rebuilt attempt returned an explicit agent rejection; the final attempt was cancelled and the QA app was quit, with shutdown confirmed. Remote terminal/SFTP in the packaged app remain unverified. The user reported no pending/rejected activity visible in 1Password. The root cause of the packaged-app-only failure remains open; do not attribute it solely to code signing or claim native 1Password compatibility from the passing test executable. QA identity/profile records are retained in the isolated QA database for reproduction.

## Connection library import and grouping

The library now exposes Import SSH config. Users can preview explicit aliases from a chosen path (default ~/.ssh/config), select hosts, choose a destination group and a fallback username, or bind imports to a saved SSH-agent identity. Import does not connect, overwrite existing profiles, or copy passwords. Successful rows are disabled after saving so a partial failure can be retried without resaving those rows. Authentication and routing should be reviewed before connecting.

The data-only parser supports quoted values, equals syntax, repeated Host declarations, wildcard/negated Host defaults, first-value precedence, and Include files with filename globs. It bounds nesting/directive counts and rejects cycles. It never executes Match exec or ProxyCommand. Match sections, ProxyJump/ProxyCommand, full OpenSSH token expansion, and globs in Include directory components are not imported. The import dialog describes the routing limitation.

Saved groups now offer collapse/expand with remembered state, counts, and a group move/rename action (blank destination ungroups). Group moves update metadata transactionally without unlocking the credential vault or disrupting sessions. The connection form exposes organization by default and suggests existing groups. Settings uses a sliders icon distinct from the appearance button.

Agent authentication now preserves each key attempt's libssh2 error instead of replacing all failures with a generic rejection. Key indexes are reported without public-key blobs or comments. Regression validation: 65 frontend tests and 38 Rust tests passed, with two live-only tests ignored by the normal suite. The separately authorized live read-only test to the configured host passed again. Linux runtime validation remains pending; the CI matrix targets macOS and Linux.

Native verification of this library change passed in the signed QA bundle: previewed two fixture aliases, imported both without connecting, observed a group with count two, renamed it, and observed its collapsed state survive switching to the saved SSH workspace. Settings and appearance icons were visually distinct. Fixture profiles remain only in the QA database under “QA imports.”

The native SSH retry first timed out in handshake. A second attempt reached agent signing: sampling the QA process showed authenticate → libssh2_agent_userauth → agent_sign → agent_transact_unix → recv_checked → recvfrom waiting on a reply. It did not complete before cancellation; the QA app was quit and shutdown confirmed. This establishes the wait location, not the cause of missing 1Password approval. The independent test-executable login passed in the same session. Inspection of 1Password's Developer view was blocked by automatic approval review due to potential exposure of unrelated vault contents; it was not bypassed.

## Ternway release branding

The user selected Ternway. The app display name, window/boot copy, native About
menu, Settings, icons and release artwork now use that identity. About shows the
runtime version, OS/architecture, author, license, source/issue/release/license
links and copyable build details (version, platform, build mode and source commit
only). QA verified About from both Settings and the macOS menu, copy feedback,
light/dark readability, retained connection groups, and signed-bundle validation.

The identifier dev.elashri.hbox-term, existing SQLite/vault filenames, configuration
directory, shell integration names, localStorage preferences, executable/package
name, repository URLs and updater trust key remain compatible. The installer
supports both old hbox-term.app and Ternway.app disk images. Release assets use
ternway-v...; updater-manifest generation accepts branded/legacy names and beta
versions, with regressions covering the change. Validation: 69 frontend tests
under Node 24 and 39 Rust tests passed.

Brand sources and the exact image-generation prompt are in docs/branding/ternway.
The generated board is concept artwork; app icons and final Manrope lettering are
editable vectors. The font's OFL notice is included. Browser preview access was
unavailable, and Safari access was rejected by automatic review; visual
verification was completed using the app's own isolated QA bundle instead.
