# Ternway design

Ternway combines local terminals with a persistent library of SSH connections.
The library supports search, grouped connections, SSH config import and reusable
SSH-agent identities. Terminal and file access lead the workspace navigation;
server tools are enabled according to endpoint capabilities.

## Storage and identities

Profiles and identity bindings are saved transactionally in SQLite. Passwords and
passphrases use a separate encrypted local vault. SSH-agent profiles hold endpoint
metadata only: private keys remain in the agent. The schema migration takes a
SQLite backup and protects identities referenced by saved connections.

## Standard SSH agents

The default endpoint is env:SSH_AUTH_SOCK, resolved from the application environment
when connecting. Absolute socket paths and ~/ paths are supported. Provider
shortcuts only discover sockets; enumeration and signing use the same standard
SSH-agent client. A local libssh2 patch prevents failed connects from double-closing
a reused descriptor, and the receive callback turns closed agent sockets into
errors. Signing still has no deadline when the agent keeps its socket open.

Normal tests start a disposable OpenSSH agent, load a generated key, check
production-client enumeration and run an OpenSSH sign/verify challenge. Authorized
live tests are opt-in and enforce known_hosts before a fixed read-only command.

## Branding and About

Brand assets live in docs/branding/ternway. About is available from Settings and
the native app menu, with runtime version/platform details, credits, license,
project links and copyable build details. Copies contain only build information.
Light/dark rendering, menu entry points, copy feedback and icon rendering were
checked using an isolated signed macOS QA bundle.

## Current limits

Packaged macOS 1Password signing can stall despite a passing test-executable login.
Linux desktop/provider testing and Bitwarden live verification remain pending.
SSH config import supports explicit aliases, Includes and common defaults, but
excludes Match/proxy routing directives and full token expansion.
