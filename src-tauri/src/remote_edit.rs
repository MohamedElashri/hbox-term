//! Editing a remote file in a local editor.
//!
//! The file is downloaded to a private temporary directory under its own name (so editors pick
//! the right syntax), then watched: every save is uploaded with the same atomic write the
//! built-in editor uses. Before uploading, the remote modification time and size are compared
//! with the version that was downloaded; if someone else changed the file, the frontend is asked
//! instead of overwriting their change.

use crate::providers;
use crate::storage::Store;
use notify::event::ModifyKind;
use notify::{EventKind, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

const SAVE_DEBOUNCE: Duration = Duration::from_millis(300);

enum Command {
    Changed,
    /// Upload even though the remote file changed since it was downloaded.
    Overwrite,
    /// Sync a last time, then stop watching and delete the local copy.
    Finish(mpsc::Sender<Result<(), String>>),
    Flush(mpsc::Sender<Result<(), String>>),
}

#[derive(Default, Clone)]
pub struct RemoteEdits(Arc<Mutex<HashMap<String, mpsc::Sender<Command>>>>);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteEditStarted {
    pub id: String,
    pub local_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteEditEvent {
    id: String,
    remote_path: String,
    /// "saved", "conflict" or "failed".
    status: &'static str,
    message: Option<String>,
}

type Version = (Option<u64>, Option<u64>);

/// The remote side of an edit; SFTP in the app, a fake in tests.
trait Remote: Send {
    fn version(&self) -> Result<Version, String>;
    fn write(&self, content: &str) -> Result<(), String>;
}

struct SftpRemote {
    store: Store,
    server_id: String,
    path: String,
    route_key: String,
}

impl SftpRemote {
    fn check_route(&self) -> Result<(), String> {
        if crate::transfer_queue::route_key(&self.store, &self.server_id)? != self.route_key {
            return Err("Connection routing changed; the local copy is retained. Review the connection before recovering it.".into());
        }
        Ok(())
    }
}

pub fn has_active(edits: &RemoteEdits) -> bool {
    edits.0.lock().map(|e| !e.is_empty()).unwrap_or(true)
}

impl Remote for SftpRemote {
    fn version(&self) -> Result<Version, String> {
        self.check_route()?;
        providers::file_version(&self.store, &self.server_id, &self.path)
    }

    fn write(&self, content: &str) -> Result<(), String> {
        self.check_route()?;
        providers::write_file(&self.store, &self.server_id, &self.path, content, None)
    }
}

#[derive(Debug, PartialEq)]
enum SyncOutcome {
    Unchanged,
    Saved,
    Conflict,
    Failed(String),
}

struct Session {
    remote: Box<dyn Remote>,
    local_path: PathBuf,
    /// The remote version this copy is based on.
    version: Version,
    synced_hash: [u8; 32],
}

fn hash(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

impl Session {
    /// Uploads the local copy if it changed since the last sync.
    fn sync(&mut self, overwrite: bool) -> SyncOutcome {
        let bytes =
            match fs::read(&self.local_path) {
                Ok(bytes) => bytes,
                Err(_) => return SyncOutcome::Failed(
                    "The local copy is temporarily unavailable; it has been retained for recovery"
                        .into(),
                ),
            };
        if hash(&bytes) == self.synced_hash {
            return SyncOutcome::Unchanged;
        }
        let Ok(content) = String::from_utf8(bytes.clone()) else {
            return SyncOutcome::Failed(
                "The file is no longer valid UTF-8 text, so it was not uploaded".into(),
            );
        };
        if !overwrite {
            match self.remote.version() {
                Ok(version) if version != self.version => return SyncOutcome::Conflict,
                Ok(_) => {}
                Err(error) => return SyncOutcome::Failed(error),
            }
        }
        if let Err(error) = self.remote.write(&content) {
            return SyncOutcome::Failed(error);
        }
        self.synced_hash = hash(&bytes);
        if let Ok(version) = self.remote.version() {
            self.version = version;
        }
        SyncOutcome::Saved
    }
}

fn report(app: &AppHandle, window_label: &str, id: &str, remote_path: &str, outcome: SyncOutcome) {
    let (status, message) = match outcome {
        SyncOutcome::Unchanged => return,
        SyncOutcome::Saved => ("saved", None),
        SyncOutcome::Conflict => ("conflict", None),
        SyncOutcome::Failed(message) => ("failed", Some(message)),
    };
    let _ = app.emit_to(
        window_label,
        "remote-edit",
        RemoteEditEvent {
            id: id.to_string(),
            remote_path: remote_path.to_string(),
            status,
            message,
        },
    );
}

pub fn start(
    app: AppHandle,
    window_label: String,
    store: Store,
    edits: RemoteEdits,
    server_id: String,
    remote_path: String,
) -> Result<RemoteEditStarted, String> {
    let route_key = crate::transfer_queue::route_key(&store, &server_id)?;
    let content = providers::read_file(&store, &server_id, &remote_path, None)?;
    let version = providers::file_version(&store, &server_id, &remote_path)?;
    if route_key != crate::transfer_queue::route_key(&store, &server_id)? {
        return Err("Connection changed while opening the remote file".into());
    }
    let id = Uuid::new_v4().to_string();
    let name = Path::new(&remote_path)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "file".into());
    use tauri::Manager;
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join("remote-edits")
        .join(&id);
    fs::create_dir_all(&dir)
        .map_err(|error| format!("Could not create {}: {error}", dir.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&dir, fs::Permissions::from_mode(0o700));
    }
    let local_path = dir.join("file").join(name);
    crate::layout_files::private_write(&local_path, content.as_bytes())?;
    let recovery = Recovery {
        id: id.clone(),
        server_id: server_id.clone(),
        remote_path: remote_path.clone(),
        local_path: local_path.display().to_string(),
        version,
        route_key: route_key.clone(),
    };
    crate::layout_files::private_write(
        &dir.join("recovery.json"),
        &serde_json::to_vec(&recovery).map_err(|e| e.to_string())?,
    )?;

    let (sender, receiver) = mpsc::channel();
    let watched = local_path.clone();
    let events = sender.clone();
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        if let Ok(event) = event {
            let changed = matches!(
                event.kind,
                EventKind::Create(_)
                    | EventKind::Modify(
                        ModifyKind::Data(_) | ModifyKind::Name(_) | ModifyKind::Any
                    )
            );
            if changed && event.paths.iter().any(|path| path == &watched) {
                let _ = events.send(Command::Changed);
            }
        }
    })
    .map_err(|error| format!("Could not watch the local copy: {error}"))?;
    // Watch the directory: many editors save by writing a new file and renaming it over.
    watcher
        .watch(local_path.parent().unwrap(), RecursiveMode::NonRecursive)
        .map_err(|error| format!("Could not watch the local copy: {error}"))?;

    let mut session = Session {
        remote: Box::new(SftpRemote {
            store,
            server_id,
            path: remote_path.clone(),
            route_key,
        }),
        local_path: local_path.clone(),
        version,
        synced_hash: hash(content.as_bytes()),
    };
    edits
        .0
        .lock()
        .map_err(|_| "Remote edit lock was poisoned".to_string())?
        .insert(id.clone(), sender);
    let registry = edits.clone();
    let id_for_thread = id.clone();
    std::thread::spawn(move || {
        let _watcher = watcher;
        let mut clean = false;
        while let Ok(command) = receiver.recv() {
            let mut replies = Vec::new();
            let mut overwrite = false;
            let mut finishing = false;
            match command {
                Command::Finish(reply) => {
                    finishing = true;
                    replies.push(reply);
                }
                Command::Flush(reply) => replies.push(reply),
                Command::Overwrite => overwrite = true,
                Command::Changed => std::thread::sleep(SAVE_DEBOUNCE),
            }
            while let Ok(next) = receiver.try_recv() {
                match next {
                    Command::Finish(reply) => {
                        finishing = true;
                        replies.push(reply);
                    }
                    Command::Flush(reply) => replies.push(reply),
                    Command::Overwrite => overwrite = true,
                    Command::Changed => {}
                }
            }
            let outcome = session.sync(overwrite);
            let result = finish_result(&outcome, &session.local_path);

            for reply in replies {
                let _ = reply.send(result.clone());
            }
            report(&app, &window_label, &id_for_thread, &remote_path, outcome);
            if finishing && result.is_ok() {
                clean = true;
                break;
            }
        }
        // Crashes, unavailable files, conflicts and failed uploads retain the only local copy.
        if clean {
            let _ = fs::remove_dir_all(&dir);
        }
        if let Ok(mut edits) = registry.0.lock() {
            edits.remove(&id_for_thread);
        }
    });
    Ok(RemoteEditStarted {
        id,
        local_path: local_path.display().to_string(),
    })
}

fn finish_result(outcome: &SyncOutcome, path: &Path) -> Result<(), String> {
    match outcome {
        SyncOutcome::Unchanged | SyncOutcome::Saved => Ok(()),
        SyncOutcome::Conflict => Err(format!(
            "Remote file changed. Your unsaved copy is retained at {}",
            path.display()
        )),
        SyncOutcome::Failed(error) => Err(format!(
            "{error}. Your unsaved copy is retained at {}",
            path.display()
        )),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Recovery {
    #[serde(default)]
    route_key: String,
    pub id: String,
    pub server_id: String,
    pub remote_path: String,
    pub local_path: String,
    version: Version,
}

pub fn recoveries(app: &AppHandle, edits: &RemoteEdits) -> Result<Vec<Recovery>, String> {
    use tauri::Manager;
    let root = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join("remote-edits");
    let mut result = Vec::new();
    if !root.exists() {
        return Ok(result);
    }
    let active = edits.0.lock().map_err(|e| e.to_string())?;
    for entry in fs::read_dir(&root).map_err(|e| e.to_string())?.take(1024) {
        let entry = entry.map_err(|e| e.to_string())?;
        let id = entry.file_name().to_string_lossy().to_string();
        if crate::layout_files::identifier(&id).is_err()
            || active.contains_key(&id)
            || !entry.file_type().is_ok_and(|t| t.is_dir())
        {
            continue;
        }
        let metadata = entry.path().join("recovery.json");
        if fs::symlink_metadata(&metadata).is_ok_and(|m| m.is_file() && m.len() < 16384) {
            if let Ok(bytes) = fs::read(metadata) {
                if let Ok(recovery) = serde_json::from_slice::<Recovery>(&bytes) {
                    let path = Path::new(&recovery.local_path);
                    if recovery.id == id
                        && path.parent() == Some(entry.path().join("file").as_path())
                        && fs::symlink_metadata(path).is_ok_and(|m| m.is_file())
                    {
                        result.push(recovery);
                    }
                }
            }
        }
    }
    Ok(result)
}

pub fn retry_recovery(
    app: &AppHandle,
    edits: &RemoteEdits,
    store: &Store,
    id: &str,
    overwrite: bool,
) -> Result<(), String> {
    let recovery = recoveries(app, edits)?
        .into_iter()
        .find(|r| r.id == id)
        .ok_or("Recovered edit no longer exists")?;
    if fs::metadata(&recovery.local_path)
        .map_err(|e| e.to_string())?
        .len()
        > 1024 * 1024
    {
        return Err("Recovered file exceeds the text editor limit".into());
    }
    if crate::transfer_queue::route_key(store, &recovery.server_id)? != recovery.route_key {
        return Err("This recovery's connection changed. Keep the local copy and upload it manually after reviewing the destination.".into());
    }
    let content = fs::read_to_string(&recovery.local_path).map_err(|e| e.to_string())?;
    if content.len() > 1024 * 1024 {
        return Err("Recovered file exceeds the text editor limit".into());
    }
    let route_key = crate::transfer_queue::route_key(store, &recovery.server_id)?;
    let mut session = Session {
        remote: Box::new(SftpRemote {
            store: store.clone(),
            server_id: recovery.server_id,
            path: recovery.remote_path,
            route_key,
        }),
        local_path: recovery.local_path.into(),
        version: recovery.version,
        synced_hash: [0; 32],
    };
    finish_result(&session.sync(overwrite), &session.local_path)?;
    fs::remove_dir_all(
        session
            .local_path
            .parent()
            .and_then(Path::parent)
            .ok_or("Missing recovery folder")?,
    )
    .map_err(|e| e.to_string())
}

fn send(edits: &RemoteEdits, id: &str, command: Command) -> Result<(), String> {
    if let Some(sender) = edits
        .0
        .lock()
        .map_err(|_| "Remote edit lock was poisoned".to_string())?
        .get(id)
    {
        sender
            .send(command)
            .map_err(|_| "Remote edit worker stopped; the local copy is retained".to_string())?;
    } else {
        return Err("Remote edit is no longer active; check recovered edits".into());
    }
    Ok(())
}

/// After a conflict: upload the local copy over the newer remote file.
pub fn overwrite(edits: &RemoteEdits, id: &str) -> Result<(), String> {
    send(edits, id, Command::Overwrite)
}

/// Preflight shutdown without deleting a file that an editor may still write.
pub fn flush(edits: &RemoteEdits, id: &str) -> Result<(), String> {
    let (reply, receive) = mpsc::channel();
    send(edits, id, Command::Flush(reply))?;
    receive
        .recv_timeout(Duration::from_secs(45))
        .map_err(|_| "Remote save has not completed; local copy retained".to_string())?
}

/// The editor closed: upload any last change, then clean up.
pub fn finish(edits: &RemoteEdits, id: &str) -> Result<(), String> {
    let (send_reply, receive) = mpsc::channel();
    send(edits, id, Command::Finish(send_reply))?;
    receive.recv_timeout(Duration::from_secs(45)).map_err(|_| {
        "Remote save has not completed; the local recovery copy is retained".to_string()
    })?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An in-memory server file; `version` changes on every write.
    #[derive(Clone, Default)]
    struct FakeRemote(Arc<Mutex<(u64, String)>>);

    impl Remote for FakeRemote {
        fn version(&self) -> Result<Version, String> {
            let file = self.0.lock().unwrap();
            Ok((Some(file.0), Some(file.1.len() as u64)))
        }

        fn write(&self, content: &str) -> Result<(), String> {
            let mut file = self.0.lock().unwrap();
            *file = (file.0 + 1, content.to_string());
            Ok(())
        }
    }

    fn session(dir: &Path, remote: &FakeRemote) -> Session {
        let local_path = dir.join("app.conf");
        fs::write(&local_path, "original").unwrap();
        remote.write("original").unwrap();
        Session {
            remote: Box::new(remote.clone()),
            local_path,
            version: remote.version().unwrap(),
            synced_hash: hash(b"original"),
        }
    }

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ternway-edit-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn uploads_saves_and_skips_unchanged_files() {
        let dir = temp_dir();
        let remote = FakeRemote::default();
        let mut session = session(&dir, &remote);
        assert_eq!(session.sync(false), SyncOutcome::Unchanged);
        fs::write(&session.local_path, "edited").unwrap();
        assert_eq!(session.sync(false), SyncOutcome::Saved);
        assert_eq!(remote.0.lock().unwrap().1, "edited");
        // A second save of the same content does not upload again.
        assert_eq!(session.sync(false), SyncOutcome::Unchanged);
        // Our own upload is the new base, so the next edit is not a conflict.
        fs::write(&session.local_path, "edited again").unwrap();
        assert_eq!(session.sync(false), SyncOutcome::Saved);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn remote_changes_are_not_overwritten_without_asking() {
        let dir = temp_dir();
        let remote = FakeRemote::default();
        let mut session = session(&dir, &remote);
        remote.write("changed by someone else").unwrap();
        fs::write(&session.local_path, "mine").unwrap();
        assert_eq!(session.sync(false), SyncOutcome::Conflict);
        assert_eq!(remote.0.lock().unwrap().1, "changed by someone else");
        assert_eq!(session.sync(true), SyncOutcome::Saved);
        assert_eq!(remote.0.lock().unwrap().1, "mine");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn binary_content_is_not_uploaded() {
        let dir = temp_dir();
        let remote = FakeRemote::default();
        let mut session = session(&dir, &remote);
        fs::write(&session.local_path, [0xff, 0xfe, 0x00]).unwrap();
        assert!(matches!(session.sync(false), SyncOutcome::Failed(_)));
        assert_eq!(remote.0.lock().unwrap().1, "original");
        fs::remove_dir_all(dir).unwrap();
    }
}

#[cfg(test)]
mod recovery_tests {
    use super::*;
    struct Failed;
    impl Remote for Failed {
        fn version(&self) -> Result<Version, String> {
            Ok((None, None))
        }
        fn write(&self, _: &str) -> Result<(), String> {
            Err("fixture offline".into())
        }
    }
    #[test]
    fn failed_missing_and_conflicted_final_saves_retain_the_local_copy() {
        let dir = std::env::temp_dir().join(format!("ternway-final-save-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("file");
        fs::write(&path, "unsaved").unwrap();
        let mut session = Session {
            remote: Box::new(Failed),
            local_path: path.clone(),
            version: (None, None),
            synced_hash: hash(b"original"),
        };
        let outcome = session.sync(false);
        assert!(finish_result(&outcome, &path).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "unsaved");
        assert!(finish_result(&SyncOutcome::Conflict, &path)
            .unwrap_err()
            .contains(path.to_str().unwrap()));
        fs::remove_file(&path).unwrap();
        assert!(matches!(session.sync(false), SyncOutcome::Failed(_)));
        assert!(dir.exists());
        let _ = fs::remove_dir_all(dir);
    }
}
