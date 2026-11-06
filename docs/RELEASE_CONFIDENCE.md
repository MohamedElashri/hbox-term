# Release confidence

## Automated checks

Every PR runs the macOS/Linux build and unit suites plus disposable password and native
OpenSSH fixtures. `make test-soak` repeats 12 real PTY/job-cleanup lifecycles, transferring
73,728,000 output bytes with Unicode/full-screen controls and 1,212 resizes; increase
`TERNWAY_SOAK_CYCLES` locally for a longer run. `Native Linux GUI` additionally runs a real WebKitGTK app on Ubuntu
24.04 under X11/Xvfb and Wayland/Weston, using the same compiled binary in separate
isolated runs. The Wayland run has no X11 fallback.

The native harness uses a separate `dev.elashri.ternway.ci` identifier and temporary
XDG directories. It checks terminal UTF-8 process output, resize, settings/dark mode,
save-without-connect, Git exclusion and repeat SSH imports, secret-free backup, named
layouts, ordinary windows and an all-window save/reopen cycle. Screenshots and test-only
logs are retained as CI artifacts for seven days. No live account or provider credentials
are used. It is a bounded smoke run, not proof of every Linux desktop/GPU combination.

Local macOS verification uses the isolated `dev.elashri.ternway.qa` app and native UI
controls. The official manual tauri-driver stack has no WKWebView driver on macOS;
Linux automation does not stand in for native macOS input/rendering checks.

The release regression sweep also covers secret clearing without losing unsaved connection
details, password rejection/retry, generated-host fingerprint review, the root-filesystem
overview, SFTP file editing/rename/permissions/delete, a paused and resumed binary upload,
queued download byte equality, and checksum-previewed backup restoration with a rollback
copy. These run through the real native app and a disposable SSH/SFTP server. Its Linux
overview is representative fixture output, not a live system-administration environment.
Remote-tool checks additionally cover process tables, failed systemd units and details,
cron, architecture-aware installed/searchable APT packages, accounts/groups, journal output, sockets,
container resources and disk scans. Those shell responses are fixtures over a real SSH
transport; destructive administration commands are never executed on a live server.
`make test-managed-tools` exercises the managed SSH/SFTP path on both CI platforms.
Debug QA processes set `TERNWAY_QA_KNOWN_HOSTS` to an isolated absolute file; production
builds ignore that override and use the user's OpenSSH trust file. QA never changes `HOME`.

Cron regressions check Linux Sunday numbering, day-of-month/day-of-week union, shorthand
schedules, environment declarations and exact shell-command whitespace. Next-run values are
UTC-based estimates; the server's cron timezone and daemon-specific extensions may differ.

## Live SSH-agent approval

The macOS QA app successfully used the 1Password agent for a test signature and then logged
into the explicitly authorized test server with the managed SSH client. A read-only overview
loaded, and the test connection was disconnected. No password-manager secret fields or private
keys were read. The previously missing approval was diagnosed in 1Password's own log:
it queued a background prompt, then timed out after 60 seconds. Opening the 1Password
menu-bar icon and approving **SSH request waiting** completed signing. Cached approvals can
make subsequent requests succeed without another prompt. Activity recording was restored to
off after the check, and no diagnostic report was sent anywhere.

See [1Password's background-prompt behavior](https://www.1password.dev/ssh/agent/compatibility#using-git-autofetch).
Ternway's connecting view now points SSH-agent users to the agent's menu-bar/tray icon when
an approval dialog does not appear. This functional check used an ad-hoc QA bundle and does
not replace production signing or notarization verification.

Primary tooling references: [Tauri WebDriver](https://v2.tauri.app/develop/tests/webdriver/),
[CI setup](https://v2.tauri.app/develop/tests/webdriver/ci/),
[Weston](https://mvlad.pages.freedesktop.org/weston/toc/running-weston.html).

## Restart and recovery

Updater restart uses the same serial, token-scoped all-window save barrier as Quit.
Every window confirms active work, flushes remote edits and saves before restart.
Acknowledged windows freeze input until completion/cancellation, and new windows are
blocked during shutdown so the saved set cannot change underneath it. A
cancel, failed save, missing acknowledgement or two-minute deadline cancels the request;
windows remain open. Old/duplicate replies cannot satisfy a new request or change its
Quit/Restart intent. The Restart Ternway command is also available in the command palette.

Layouts reopen dormant and do not run commands or reconnect. A corrupt transfer queue
is quarantined with a visible recovery notice, preserving its original bytes and file
checkpoints while allowing the terminal to start. Queue jobs reopen paused;
file checkpoints and failed remote edits remain available for recovery. Update downloads
must pass signature verification before installation. Tests cover failed downloads,
installation/restart errors, repeated clicks and retry behavior. Release manifests must
include matching updater signatures for each supported architecture.

## Production macOS signing and notarization

Release tags now fail before creating a draft if production credentials are missing.
The previous ad-hoc distribution fallback is removed. The build must pass Developer ID
signature/hardened-runtime verification, Gatekeeper assessment and stapled-ticket checks
before the release can publish. Existing published releases cannot be modified by a rerun.
Local ad-hoc QA builds remain available and are not production release artifacts.
The macOS installer checks the mounted app's signature, Gatekeeper approval and stapled
notarization ticket before replacing an installed copy. It keeps quarantine protections
intact and detaches the image after verification failures. Mocked installer tests cover
successful verification and rejection at each gate without mounting or installing anything.

Configure these GitHub Actions **secrets** yourself through repository settings:

| Secret | Purpose |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | Existing updater artifact-signing key |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Optional password for that key |
| `APPLE_CERTIFICATE` | Base64-encoded Developer ID Application `.p12` certificate/key |
| `APPLE_CERTIFICATE_PASSWORD` | Password protecting the `.p12` |
| `APPLE_API_ISSUER` | App Store Connect API issuer ID |
| `APPLE_API_KEY` | API key ID |
| `APPLE_API_PRIVATE_KEY` | Contents of the corresponding `.p8` file |

Set the **repository variable** `APPLE_SIGNING_IDENTITY` to the exact
`Developer ID Application: … (TEAMID)` identity. The preflight receives only secret
presence flags. The API private key is written owner-only to a temporary file on the
macOS runner and removed even after a failed build. The normal Linux build never receives
Apple private credentials.

Follow [Tauri's signing and notarization guide](https://v2.tauri.app/distribute/sign/macos/)
and Apple's account instructions when creating/exporting credentials. Do not put these
values in source, chat, PR descriptions or logs. Private keys are not automatically
exported from the local Keychain or uploaded to GitHub by these development checks.

Current prerequisite audit: GitHub has the updater signing key, but Apple signing/API
secrets are not yet configured. The local Developer ID
identity generated a timestamped hardened-runtime signature, but Gatekeeper rejected it
with `CSSMERR_TP_CERT_REVOKED` and macOS refused launch. Replace that certificate before
using it for distribution. CI notarization/publication verification remains pending a
replacement certificate and those credentials; a green unit/GUI
PR does not imply a notarized distribution was produced. Notarization verification is
deferred at the user's request. No release tag is created by this stage.

## Manual release gates

Before publishing a version, verify the final signed/notarized bundles on supported
macOS architectures and Linux packages on X11 and Wayland. Check non-US keyboard/IME
input, GPU/scale variations, sleep/wake, lock/unlock, changed networks, multiple windows,
large transfers, update/restart recovery, and a longer daily-workload soak. Record real
provider approval behavior separately. Live 1Password/Bitwarden password retrieval was
deferred at the user's request; fixture coverage does not close that gate.

The macOS regression check also confirms that switching ordinary windows preserves a
connection draft's non-secret fields while clearing its password, local terminal Unicode
output remains searchable, and the development build's GitHub update check completes.
