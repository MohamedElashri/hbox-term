//! Password retrieval is explicit, bounded and never invokes a shell or persists output.
use serde::{Deserialize, Serialize};
use std::{
    io::Read,
    path::PathBuf,
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    },
    time::{Duration, Instant},
};
use zeroize::Zeroizing;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PasswordReference {
    pub provider: Provider,
    pub reference: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Provider {
    OnePassword,
    Bitwarden,
}

impl PasswordReference {
    pub fn validate(&self) -> Result<(), String> {
        let value = &self.reference;
        let valid = !value.chars().any(char::is_control)
            && value.len() <= 2048
            && match self.provider {
                Provider::OnePassword => value.strip_prefix("op://").is_some_and(|v| {
                    v.split('/').count() >= 3
                        && v.split('/').all(|p| !p.is_empty())
                        && !v.contains('?')
                }),
                Provider::Bitwarden => uuid::Uuid::parse_str(value).is_ok(),
            };
        if valid {
            Ok(())
        } else {
            Err("Enter an op://vault/item/field reference or a Bitwarden item UUID for the selected provider".into())
        }
    }
    fn program(&self) -> &'static str {
        match self.provider {
            Provider::OnePassword => "op",
            Provider::Bitwarden => "bw",
        }
    }
    fn command(&self, executable: PathBuf) -> Command {
        let mut command = Command::new(executable);
        match self.provider {
            Provider::OnePassword => {
                command.args(["read", "--no-newline", &self.reference]);
            }
            Provider::Bitwarden => {
                command.args([
                    "get",
                    "password",
                    &self.reference,
                    "--raw",
                    "--nointeraction",
                ]);
            }
        }
        command
    }
    pub fn retrieve(
        &self,
        cancelled: Option<&Arc<AtomicBool>>,
    ) -> Result<Zeroizing<String>, String> {
        self.validate()?;
        let executable = find_program(self.program()).ok_or_else(|| {
            format!(
                "Install {} CLI and sign in before connecting with this password reference",
                self.program()
            )
        })?;
        run_secret(self.command(executable), Duration::from_secs(90), cancelled)
    }
}

fn find_program(name: &str) -> Option<PathBuf> {
    let mut dirs: Vec<_> = std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
        .filter(|p| p.is_absolute())
        .collect();
    dirs.extend(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"].map(PathBuf::from));
    dirs.into_iter().map(|p| p.join(name)).find(|p| {
        use std::os::unix::fs::PermissionsExt;
        p.metadata()
            .is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
    })
}

fn run_secret(
    mut command: Command,
    timeout: Duration,
    cancelled: Option<&Arc<AtomicBool>>,
) -> Result<Zeroizing<String>, String> {
    crate::appimage::apply_std(&mut command);
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "Could not start password provider".to_string())?;
    let mut stdout = child.stdout.take().unwrap();
    let (send, receive) = mpsc::sync_channel(4);
    std::thread::spawn(move || {
        let mut chunk = Zeroizing::new([0; 4096]);
        loop {
            match stdout.read(&mut *chunk) {
                Ok(0) => break,
                Err(_) => {
                    let _ = send.send(Err(()));
                    break;
                }
                Ok(n) => {
                    if send.send(Ok(Zeroizing::new(chunk[..n].to_vec()))).is_err() {
                        break;
                    }
                }
            }
        }
    });
    let started = Instant::now();
    let mut output = Zeroizing::new(Vec::new());
    let result = loop {
        if cancelled.is_some_and(|c| c.load(Ordering::SeqCst)) {
            break Err(crate::ssh::OPERATION_CANCELLED.to_owned());
        }
        if started.elapsed() >= timeout {
            break Err(
                "Password provider timed out; unlock the provider and try connecting again".into(),
            );
        }
        match receive.recv_timeout(Duration::from_millis(25)) {
            Ok(Ok(bytes)) if output.len() + bytes.len() <= 65536 => output.extend_from_slice(&bytes),
            Ok(Ok(_)) => break Err("Password provider returned too much data".into()),
            Ok(Err(())) => break Err("Could not read password provider output".into()),
            Err(mpsc::RecvTimeoutError::Timeout) => {},
            Err(mpsc::RecvTimeoutError::Disconnected) => match child.try_wait() {
                Ok(Some(status)) if status.success() => {
                    // bw appends a single line terminator; op --no-newline preserves exact bytes.
                    if command.get_program().to_string_lossy().ends_with("bw") && output.last() == Some(&b'\n') { output.pop(); if output.last() == Some(&b'\r') { output.pop(); } }
                    break std::str::from_utf8(&output).map(|s| Zeroizing::new(s.to_owned())).map_err(|_| "Password provider returned invalid text".into()).and_then(|s| if s.is_empty() { Err("Password provider returned an empty password".into()) } else { Ok(s) });
                }
                Ok(Some(_)) => break Err("Password provider could not retrieve this field. Check the reference, sign in and unlock the provider, then retry. Provider output is hidden to protect secrets.".into()),
                Ok(None) => std::thread::sleep(Duration::from_millis(25)),
                Err(_) => break Err("Could not read password provider status".into()),
            },
        }
    };
    if result.is_err() {
        let _ = child.kill();
    }
    let _ = child.wait();
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn references_are_data_and_reject_options_and_controls() {
        for value in ["--help", "op://v/i/f?attribute=otp", "op://v/i/f\n"] {
            assert!(PasswordReference {
                provider: Provider::OnePassword,
                reference: value.into()
            }
            .validate()
            .is_err());
        }
        assert!(PasswordReference {
            provider: Provider::OnePassword,
            reference: "op://Work/SSH/password".into()
        }
        .validate()
        .is_ok());
        assert!(PasswordReference {
            provider: Provider::Bitwarden,
            reference: uuid::Uuid::new_v4().to_string()
        }
        .validate()
        .is_ok());
    }
    #[test]
    fn subprocess_preserves_whitespace_hides_errors_and_is_bounded() {
        let mut cmd = Command::new("/usr/bin/printf");
        cmd.arg(" secret with spaces \n");
        assert_eq!(
            &**run_secret(cmd, Duration::from_secs(1), None).unwrap(),
            " secret with spaces \n"
        );
        let mut cmd = Command::new("/bin/sh");
        cmd.args(["-c", "printf SECRET >&2; exit 1"]);
        assert!(!run_secret(cmd, Duration::from_secs(1), None)
            .unwrap_err()
            .contains("SECRET"));
        let mut cmd = Command::new("/usr/bin/yes");
        cmd.arg("secret");
        assert!(run_secret(cmd, Duration::from_secs(1), None)
            .unwrap_err()
            .contains("too much"));
        let mut cmd = Command::new("/bin/sleep");
        cmd.arg("5");
        assert!(run_secret(cmd, Duration::from_millis(30), None)
            .unwrap_err()
            .contains("timed out"));
        let cancel = Arc::new(AtomicBool::new(true));
        let mut cmd = Command::new("/bin/sleep");
        cmd.arg("5");
        assert!(run_secret(cmd, Duration::from_secs(1), Some(&cancel))
            .unwrap_err()
            .contains("Operation cancelled"));
    }
}
