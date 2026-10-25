//! Shell integration for SSH sessions (`remote-shell-integration = true`): the scripts are
//! installed once per version in `~/.cache/hbox-term/shell-integration/<version>/` over SFTP, and
//! the remote login shell is started through them like a local one (zsh via ZDOTDIR, fish via
//! XDG_DATA_DIRS, bash via an rcfile that acts like a login shell).

use crate::local_pty::INTEGRATION_FILES;
use crate::ssh::SshClient;
use sha2::{Digest, Sha256};
use std::io::Write;
use std::path::{Path, PathBuf};

/// Starts `$SHELL` through the integration. Runs under /bin/sh whatever the login shell is;
/// $1 is the integration directory and $2 an optional directory to start in.
const LAUNCHER: &str = r#"d="$1"; [ -n "$2" ] && cd "$2" 2>/dev/null; s="${SHELL:-/bin/sh}"; export HBOX_TERM_SHELL_INTEGRATION="$d"; case "${s##*/}" in zsh) if [ -n "${ZDOTDIR+x}" ]; then export HBOX_TERM_ZDOTDIR="$ZDOTDIR"; fi; export ZDOTDIR="$d/zsh"; exec "$s" -l;; bash) exec "$s" --rcfile "$d/bash/login.bash" -i;; fish) export XDG_DATA_DIRS="$d/fish:${XDG_DATA_DIRS:-/usr/local/share:/usr/share}" HBOX_TERM_FISH_DATA_DIR="$d/fish"; exec "$s" -l;; *) exec "$s" -l;; esac"#;

/// A short hash of the scripts, so updated scripts install next to (not over) old ones.
fn version() -> String {
    let mut hasher = Sha256::new();
    for (path, contents) in INTEGRATION_FILES {
        hasher.update(path.as_bytes());
        hasher.update(contents.as_bytes());
    }
    hasher.finalize()[..6]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Installs the scripts on the server if this version is missing; returns their directory.
pub fn prepare(client: &SshClient) -> Result<String, String> {
    let sftp = client.sftp()?;
    let home = sftp
        .realpath(Path::new("."))
        .map_err(|error| format!("Could not find the remote home directory: {error}"))?;
    let dir = home
        .join(".cache/hbox-term/shell-integration")
        .join(version());
    if sftp.stat(&dir.join("bash/login.bash")).is_err() {
        for (path, contents) in INTEGRATION_FILES {
            let target = dir.join(path);
            create_dirs(&sftp, &home, target.parent().unwrap_or(&dir));
            let mut file = sftp
                .create(&target)
                .map_err(|error| format!("Could not write {}: {error}", target.display()))?;
            file.write_all(contents.as_bytes())
                .map_err(|error| format!("Could not write {}: {error}", target.display()))?;
        }
    }
    dir.to_str()
        .map(str::to_string)
        .ok_or_else(|| "The remote home directory is not valid UTF-8".to_string())
}

/// `mkdir -p` below `home` (existing directories are fine).
fn create_dirs(sftp: &ssh2::Sftp, home: &Path, dir: &Path) {
    let mut current = PathBuf::from(home);
    for component in dir.strip_prefix(home).unwrap_or(dir).components() {
        current.push(component);
        let _ = sftp.mkdir(&current, 0o755);
    }
}

fn quote(value: &str) -> Option<String> {
    // Single quotes work the same in sh, bash, zsh and fish when the value has none itself.
    (!value.contains('\'')).then(|| format!("'{value}'"))
}

/// The command for the SSH channel: run by the user's login shell, which hands over to /bin/sh.
pub fn command(dir: &str, cwd: Option<&str>) -> Option<String> {
    let cwd = cwd.and_then(quote).unwrap_or_else(|| "''".into());
    Some(format!(
        "exec /bin/sh -c {} hbox-term {} {cwd}",
        quote(LAUNCHER)?,
        quote(dir)?
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    #[test]
    fn launcher_runs_under_sh_with_paths_as_arguments() {
        let dir = std::env::temp_dir().join(format!("hbox-remote-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        // The launcher execs $SHELL; a fake shell prints how it was started.
        let fake = dir.join("fakesh");
        std::fs::write(
            &fake,
            "#!/bin/sh\necho \"args=$* zdotdir=$ZDOTDIR pwd=$(pwd)\"\n",
        )
        .unwrap();
        std::fs::set_permissions(&fake, std::os::unix::fs::PermissionsExt::from_mode(0o755))
            .unwrap();
        let command = command("/opt/hbox it", Some("/tmp")).unwrap();
        let output = Command::new("/bin/sh")
            .args(["-c", &command])
            .env("SHELL", &fake)
            .output()
            .unwrap();
        let text = String::from_utf8_lossy(&output.stdout);
        assert_eq!(text.trim(), "args=-l zdotdir= pwd=/tmp", "{text}");
        assert!(command.starts_with("exec /bin/sh -c '"));
        // zsh gets the integration ZDOTDIR, bash the login rcfile.
        for (name, expected) in [
            ("zsh", "args=-l zdotdir=/opt/hbox it/zsh"),
            (
                "bash",
                "args=--rcfile /opt/hbox it/bash/login.bash -i zdotdir=",
            ),
        ] {
            let shell = dir.join(name);
            std::fs::copy(&fake, &shell).unwrap();
            let output = Command::new("/bin/sh")
                .args(["-c", &super::command("/opt/hbox it", None).unwrap()])
                .env("SHELL", &shell)
                .output()
                .unwrap();
            let text = String::from_utf8_lossy(&output.stdout);
            assert!(text.trim().starts_with(expected), "{name}: {text}");
        }
        assert_eq!(super::command("/it's", None), None);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn version_is_stable_and_short() {
        assert_eq!(version(), version());
        assert_eq!(version().len(), 12);
    }
}
