# OpenSSH connections

Choose **OpenSSH config** in the connection editor, or **Keep linked to OpenSSH config**
when importing. Ternway saves the alias and configuration reference, then launches the
installed `/usr/bin/ssh` in an interactive terminal. It does not flatten the configuration
or run SSH while discovering or saving connections.

OpenSSH evaluates its configuration at connection time. This covers ProxyJump chains,
ProxyCommand, dynamic Match rules, canonicalization, IdentityAgent, multiple IdentityFile
and CertificateFile entries, hardware keys, authentication preferences, host-key policies,
forwarding and multiplexing, subject to the installed client's capabilities.
See the [OpenSSH client manual](https://man.openbsd.org/ssh) and
[configuration reference](https://man.openbsd.org/ssh_config).

| Behavior | OpenSSH config connection | Managed connection |
| --- | --- | --- |
| Configuration | Live alias/file reference | Copies supported settings |
| User and system defaults | Normal OpenSSH defaults; custom files use `-F` | Imported supported fields |
| Authentication and MFA | Prompts in the terminal; configured agents/providers | Ternway password vault, key or agent |
| ProxyJump, ProxyCommand, dynamic rules | OpenSSH evaluates them when connecting | Unsupported import settings require manual setup |
| Graphical file and server tools | Not yet available | Available according to host capabilities |
| Remote shell integration and split cwd | Determined by the original config | Ternway integration when enabled |

Leave the config file blank for normal user and system configuration. Linking the usual
`~/.ssh/config` also retains system defaults. Other files are passed with `-F`, which
excludes system defaults. Use `none` to explicitly ignore configuration files.

Aliases requiring advanced settings are available for explicit selection during linked
import. Git service aliases remain unchecked. Wildcard-only or connection-dependent Include
files may not provide a discoverable alias; add a connection by alias or hostname manually.
Discovery expands local Include tokens `%d`, `%u` and `%%` without executing commands.

Configured commands and forwarding take effect when a terminal opens. Closing it ends
Ternway's SSH process; background connections requested by ControlPersist or other config
hooks retain OpenSSH's normal lifetime. Ternway does not terminate shared external masters.
Changes to the file apply to the next terminal or reconnect.

Compatibility follows the installed OpenSSH version. The macOS client tested here fails
with ProxyJump when a custom config filename contains spaces, including when invoked outside
Ternway. Use a filename without spaces for that combination. Direct connections with spaced
config filenames are tested.

## Verification

macOS and Linux CI run a disposable SSH fixture with generated keys and isolated known_hosts.
It exercises ProxyJump, ProxyCommand, multiple keys, IdentityAgent none, Match exec at connect
time, RemoteCommand, strict host-key checking, password input without echo, live config edits,
PTY resize and closing the correct remote session. Discovery and save tests verify that config
commands do not execute. Hardware devices, real password managers and external network policies
still need separate live checks.
