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
use serde::Serialize;
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
    Finish,
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
}

impl Remote for SftpRemote {
    fn version(&self) -> Result<Version, String> {
        providers::file_version(&self.store, &self.server_id, &self.path)
    }

    fn write(&self, content: &str) -> Result<(), String> {
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
        let Ok(bytes) = fs::read(&self.local_path) else {
            // Editors may briefly remove the file while saving; the next event retries.
            return SyncOutcome::Unchanged;
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

fn report(app: &AppHandle, id: &str, remote_path: &str, outcome: SyncOutcome) {
    let (status, message) = match outcome {
        SyncOutcome::Unchanged => return,
        SyncOutcome::Saved => ("saved", None),
        SyncOutcome::Conflict => ("conflict", None),
        SyncOutcome::Failed(message) => ("failed", Some(message)),
    };
    let _ = app.emit(
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
    store: Store,
    edits: RemoteEdits,
    server_id: String,
    remote_path: String,
) -> Result<RemoteEditStarted, String> {
    let content = providers::read_file(&store, &server_id, &remote_path, None)?;
    let version = providers::file_version(&store, &server_id, &remote_path)?;
    let id = Uuid::new_v4().to_string();
    let name = Path::new(&remote_path)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "file".into());
    let dir = std::env::temp_dir().join("hbox-term-edit").join(&id);
    fs::create_dir_all(&dir)
        .map_err(|error| format!("Could not create {}: {error}", dir.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&dir, fs::Permissions::from_mode(0o700));
    }
    let local_path = dir.join(name);
    fs::write(&local_path, &content)
        .map_err(|error| format!("Could not write {}: {error}", local_path.display()))?;

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
        .watch(&dir, RecursiveMode::NonRecursive)
        .map_err(|error| format!("Could not watch the local copy: {error}"))?;

    let mut session = Session {
        remote: Box::new(SftpRemote {
            store,
            server_id,
            path: remote_path.clone(),
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
        while let Ok(command) = receiver.recv() {
            match command {
                Command::Changed => {
                    // Coalesce the burst of events a single save produces.
                    std::thread::sleep(SAVE_DEBOUNCE);
                    let (mut finish, mut overwrite) = (false, false);
                    while let Ok(next) = receiver.try_recv() {
                        finish |= matches!(next, Command::Finish);
                        overwrite |= matches!(next, Command::Overwrite);
                    }
                    report(&app, &id_for_thread, &remote_path, session.sync(overwrite));
                    if finish {
                        break;
                    }
                }
                Command::Overwrite => {
                    report(&app, &id_for_thread, &remote_path, session.sync(true))
                }
                Command::Finish => {
                    report(&app, &id_for_thread, &remote_path, session.sync(false));
                    break;
                }
            }
        }
        let _ = fs::remove_dir_all(&dir);
        if let Ok(mut edits) = registry.0.lock() {
            edits.remove(&id_for_thread);
        }
    });
    Ok(RemoteEditStarted {
        id,
        local_path: local_path.display().to_string(),
    })
}

fn send(edits: &RemoteEdits, id: &str, command: Command) -> Result<(), String> {
    if let Some(sender) = edits
        .0
        .lock()
        .map_err(|_| "Remote edit lock was poisoned".to_string())?
        .get(id)
    {
        let _ = sender.send(command);
    }
    Ok(())
}

/// After a conflict: upload the local copy over the newer remote file.
pub fn overwrite(edits: &RemoteEdits, id: &str) -> Result<(), String> {
    send(edits, id, Command::Overwrite)
}

/// The editor closed: upload any last change, then clean up.
pub fn finish(edits: &RemoteEdits, id: &str) -> Result<(), String> {
    send(edits, id, Command::Finish)
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
        let dir = std::env::temp_dir().join(format!("hbox-edit-test-{}", Uuid::new_v4()));
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
