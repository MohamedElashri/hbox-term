//! Private app-owned masters. Slave requests never fall back to fresh authentication.
use crate::models::ServerProfile;
use crate::ssh::{profile_key, ExecOutput};
use crate::terminal::TerminalSessions;
use sha2::{Digest, Sha256};
use std::os::unix::fs::DirBuilderExt;
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::{atomic::AtomicBool, Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};

#[derive(Clone)]
struct Entry {
    key: String,
    socket: PathBuf,
    primary: String,
    created: Instant,
}
static ENTRIES: OnceLock<Mutex<HashMap<String, Entry>>> = OnceLock::new();
fn entries() -> &'static Mutex<HashMap<String, Entry>> {
    ENTRIES.get_or_init(Default::default)
}
fn directory() -> Result<&'static PathBuf, String> {
    static DIR: OnceLock<Result<PathBuf, String>> = OnceLock::new();
    DIR.get_or_init(|| {
        let path = PathBuf::from(format!(
            "/tmp/tw-{}-{}",
            std::process::id(),
            &uuid::Uuid::new_v4().simple().to_string()[..12]
        ));
        fs::DirBuilder::new()
            .mode(0o700)
            .create(&path)
            .map_err(|e| format!("Could not create private SSH control directory: {e}"))?;
        Ok(path)
    })
    .as_ref()
    .map_err(Clone::clone)
}
fn control(socket: &Path, operation: &str) -> Command {
    let mut command = Command::new("/usr/bin/ssh");
    command.args(["-F", "/dev/null", "-S"]).arg(socket).args([
        "-oControlMaster=no",
        "-O",
        operation,
        "--",
        "ternway-owned-session",
    ]);
    command
}
fn alive(socket: &Path) -> bool {
    socket.exists()
        && crate::child_process::run(
            control(socket, "check"),
            None,
            8192,
            Duration::from_secs(1),
            None,
        )
        .is_ok_and(|o| o.exit_code == 0)
}
fn close(entry: &Entry) {
    if entry.socket.exists() {
        let _ = crate::child_process::run(
            control(&entry.socket, "exit"),
            None,
            8192,
            Duration::from_secs(2),
            None,
        );
    }
    let _ = fs::remove_file(&entry.socket);
}
pub(crate) fn prepare(
    profile: &ServerProfile,
    session: &str,
    terminals: &TerminalSessions,
) -> Result<Option<PathBuf>, String> {
    if !profile
        .open_ssh
        .as_ref()
        .is_some_and(|r| r.share_connection)
    {
        return Ok(None);
    }
    let mut entries = entries().lock().map_err(|e| e.to_string())?;
    let key = profile_key(profile);
    if let Some(entry) = entries.get(&profile.id) {
        if entry.key == key && alive(&entry.socket) {
            return Ok(Some(entry.socket.clone()));
        }
        if entry.key == key
            && (entry.created.elapsed() < Duration::from_secs(2)
                || terminals
                    .lock()
                    .map_err(|e| e.to_string())?
                    .contains_key(&entry.primary))
        {
            return Err("Authentication is pending in this connection's existing terminal".into());
        }
        close(entry);
    }
    let digest = Sha256::digest(profile.id.as_bytes());
    let name = format!(
        "m-{:x}-{}",
        u32::from_be_bytes(digest[..4].try_into().unwrap()),
        &uuid::Uuid::new_v4().simple().to_string()[..8]
    );
    let socket = directory()?.join(name);
    entries.insert(
        profile.id.clone(),
        Entry {
            key,
            socket: socket.clone(),
            primary: session.into(),
            created: Instant::now(),
        },
    );
    Ok(Some(socket))
}
pub(crate) fn ready(profile: &ServerProfile) -> bool {
    entries()
        .lock()
        .ok()
        .and_then(|entries| entries.get(&profile.id).cloned())
        .is_some_and(|entry| entry.key == profile_key(profile) && alive(&entry.socket))
}
pub(crate) fn socket(profile: &ServerProfile) -> Result<PathBuf, String> {
    let entry = entries()
        .lock()
        .map_err(|e| e.to_string())?
        .get(&profile.id)
        .cloned();
    match entry {
        Some(entry) if entry.key == profile_key(profile) && alive(&entry.socket) => {
            Ok(entry.socket)
        }
        _ => Err(
            "Shared SSH session is not ready. Connect and authenticate in its terminal first"
                .into(),
        ),
    }
}
pub(crate) fn disconnect(id: &str) {
    if let Some(entry) = entries()
        .lock()
        .ok()
        .and_then(|mut entries| entries.remove(id))
    {
        close(&entry);
    }
}
pub(crate) fn stop_all() {
    let owned: Vec<_> = entries()
        .lock()
        .map(|mut entries| entries.drain().map(|(_, e)| e).collect())
        .unwrap_or_default();
    for entry in owned {
        close(&entry);
    }
}
pub(crate) fn slave(
    profile: &ServerProfile,
    subsystem: bool,
    payload: &str,
) -> Result<Command, String> {
    let socket = socket(profile)?;
    let mut command = Command::new("/usr/bin/ssh");
    command.args(["-F", "/dev/null", "-S"]).arg(socket).args([
        "-oControlMaster=no",
        "-oProxyCommand=/usr/bin/false",
        "-oBatchMode=yes",
        "-oRequestTTY=no",
    ]);
    if subsystem {
        command.arg("-s");
    }
    command.arg("--").arg(&profile.host).arg(payload);
    crate::appimage::apply_std(&mut command);
    Ok(command)
}
pub(crate) fn exec(
    profile: &ServerProfile,
    command: &str,
    input: Option<&[u8]>,
    limit: usize,
    timeout: Duration,
    cancelled: Option<&Arc<AtomicBool>>,
) -> Result<ExecOutput, String> {
    crate::child_process::run(
        slave(profile, false, command)?,
        input.map(Vec::from),
        limit,
        timeout,
        cancelled,
    )
}
pub(crate) fn forward(
    profile: &ServerProfile,
    kind: &str,
    specification: &str,
    cancel: bool,
) -> Result<(), String> {
    let socket = socket(profile)?;
    let mut command = control(&socket, if cancel { "cancel" } else { "forward" });
    let args = command.get_args().map(|v| v.to_owned()).collect::<Vec<_>>();
    command = Command::new("/usr/bin/ssh");
    let at = args.iter().position(|v| v == "--").unwrap();
    command
        .args(&args[..at])
        .arg(match kind {
            "remote" => "-R",
            "socks" => "-D",
            _ => "-L",
        })
        .arg(specification)
        .args(&args[at..]);
    let result = crate::child_process::run(command, None, 8192, Duration::from_secs(5), None)?;
    if result.exit_code == 0 {
        Ok(())
    } else {
        Err(format!("SSH forwarding failed: {}", result.stderr.trim()))
    }
}
