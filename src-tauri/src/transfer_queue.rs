//! Durable transfer intent. Restarted jobs are paused; only explicit user actions reconnect.
use crate::{AppError, AppState};
use serde::{Deserialize, Serialize};
use std::{
    io::Read,
    path::{Path, PathBuf},
    sync::{atomic::AtomicBool, Arc, Mutex},
};
use tauri::{AppHandle, Emitter, State};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    #[serde(default)]
    pub connection_key: String,
    pub id: String,
    pub server_id: String,
    pub direction: String,
    pub local_path: String,
    pub remote_path: String,
    pub overwrite: bool,
    pub status: String,
    pub error: Option<String>,
}
#[derive(Serialize, Deserialize)]
struct Document {
    version: u32,
    jobs: Vec<Job>,
}
pub struct TransferQueue {
    path: PathBuf,
    jobs: Mutex<Vec<Job>>,
    recovery_notice: Option<String>,
}
impl TransferQueue {
    pub fn open(path: PathBuf) -> Result<Self, String> {
        let mut jobs = if path.exists() {
            let metadata = std::fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
            if !metadata.is_file() || metadata.len() > 4 * 1024 * 1024 {
                return Err("Invalid transfer queue file".into());
            }
            let document: Document = serde_json::from_slice(
                &std::fs::read(&path).map_err(|e| e.to_string())?,
            )
            .map_err(|_| "Transfer queue is damaged; keep the file for recovery".to_string())?;
            if document.version != 1 || document.jobs.len() > 1024 {
                return Err("Unsupported transfer queue".into());
            }
            let unique: std::collections::HashSet<_> =
                document.jobs.iter().map(|j| &j.id).collect();
            if unique.len() != document.jobs.len() {
                return Err("Duplicate transfer identifiers in queue".into());
            }
            for job in &document.jobs {
                validate(job)?;
            }
            document.jobs
        } else {
            Vec::new()
        };
        for job in &mut jobs {
            if job.status == "running" || job.status == "queued" {
                job.status = "paused".into();
            }
        }
        Ok(Self {
            path,
            jobs: Mutex::new(jobs),
            recovery_notice: None,
        })
    }
    pub fn open_recovering(path: PathBuf) -> Result<Self, String> {
        match Self::open(path.clone()) {
            Ok(queue) => Ok(queue),
            Err(error) => {
                if !std::fs::symlink_metadata(&path).is_ok_and(|m| m.is_file()) {
                    return Err(error);
                }
                let retained = path
                    .with_file_name(format!("transfers-recovery-{}.json", uuid::Uuid::new_v4()));
                std::fs::rename(&path, &retained)
                    .map_err(|e| format!("Could not retain damaged queue: {e}"))?;
                let mut queue = Self::open(path)?;
                queue.recovery_notice=Some(format!("The previous transfer queue could not be read. It was retained at {}. No jobs were started. File checkpoints were kept.",retained.display()));
                Ok(queue)
            }
        }
    }
    pub fn pending_count(&self, server: Option<&str>) -> usize {
        self.jobs
            .lock()
            .map(|jobs| {
                jobs.iter()
                    .filter(|j| {
                        ["running", "queued"].contains(&j.status.as_str())
                            && server.is_none_or(|s| s == j.server_id)
                    })
                    .count()
            })
            .unwrap_or(0)
    }
    pub fn restore_library(
        &self,
        change: impl FnOnce() -> Result<(), String>,
    ) -> Result<(), String> {
        let mut jobs = self.jobs.lock().map_err(|e| e.to_string())?;
        if jobs.iter().any(|j| j.status == "running") {
            return Err("Pause the running transfer before restoring the library".into());
        }
        change()?;
        for job in jobs.iter_mut() {
            if job.status != "complete" {
                job.status = "invalidated".into();
                job.error=Some("The library was restored. Create a new transfer after reviewing its connection and paths.".into());
            }
        }
        self.persist(&jobs)
    }
    fn persist(&self, jobs: &[Job]) -> Result<(), String> {
        let bytes = serde_json::to_vec(&Document {
            version: 1,
            jobs: jobs.to_vec(),
        })
        .map_err(|e| e.to_string())?;
        if bytes.len() > 4 * 1024 * 1024 {
            return Err(
                "Transfer queue exceeds 4 MiB; remove completed history before adding more jobs"
                    .into(),
            );
        }
        crate::layout_files::private_write(&self.path, &bytes)
    }
    fn update(
        &self,
        change: impl FnOnce(&mut Vec<Job>) -> Result<(), String>,
    ) -> Result<Vec<Job>, String> {
        let mut jobs = self.jobs.lock().map_err(|e| e.to_string())?;
        let mut next = jobs.clone();
        change(&mut next)?;
        self.persist(&next)?;
        *jobs = next;
        Ok(jobs.clone())
    }
}
pub(crate) fn route_key(store: &crate::storage::Store, id: &str) -> Result<String, String> {
    let db = store.connection.lock().map_err(|e| e.to_string())?;
    let revision: String = db
        .query_row(
            "SELECT COALESCE((SELECT token FROM restore_marker LIMIT 1),'')",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    drop(db);
    let mut result = revision;
    let mut current = Some(id.to_string());
    let mut visited = std::collections::HashSet::new();
    while let Some(id) = current {
        if !visited.insert(id.clone()) || visited.len() > 16 {
            return Err("Invalid connection route".into());
        }
        let profile = store.get_server(&id)?;
        result.push_str(&crate::ssh::profile_key(&profile));
        current = profile.jump_host_id;
    }
    Ok(result)
}
fn validate(job: &Job) -> Result<(), String> {
    crate::layout_files::identifier(&job.id)?;
    if !["upload", "download"].contains(&job.direction.as_str())
        || ![
            "queued",
            "running",
            "paused",
            "failed",
            "complete",
            "invalidated",
        ]
        .contains(&job.status.as_str())
        || job.server_id.is_empty()
        || [&job.local_path, &job.remote_path]
            .into_iter()
            .any(|p| p.is_empty() || p.len() > 8192 || p.contains('\0'))
    {
        return Err("Invalid transfer job".into());
    }
    Ok(())
}

pub fn verify_prefix(
    source: &mut impl Read,
    partial: &mut impl Read,
    mut bytes: u64,
    cancellation: Option<&Arc<AtomicBool>>,
) -> Result<(), String> {
    let mut a = [0; 32768];
    let mut b = [0; 32768];
    while bytes > 0 {
        crate::ssh::ensure_not_cancelled(cancellation)?;
        let count = bytes.min(a.len() as u64) as usize;
        source
            .read_exact(&mut a[..count])
            .map_err(|_| "Source changed or checkpoint is too long".to_string())?;
        partial
            .read_exact(&mut b[..count])
            .map_err(|_| "Checkpoint is incomplete".to_string())?;
        if a[..count] != b[..count] {
            return Err("Checkpoint differs from the source. Keep it for recovery and create a new transfer to restart safely.".into());
        }
        bytes -= count as u64;
    }
    Ok(())
}

/// Atomic no-replace rename on both supported desktop platforms.
pub fn commit_download(source: &Path, destination: &Path) -> Result<(), String> {
    use std::os::unix::ffi::OsStrExt;
    let from = std::ffi::CString::new(source.as_os_str().as_bytes()).map_err(|e| e.to_string())?;
    let to =
        std::ffi::CString::new(destination.as_os_str().as_bytes()).map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    let result = unsafe { libc::renamex_np(from.as_ptr(), to.as_ptr(), libc::RENAME_EXCL) };
    #[cfg(target_os = "linux")]
    let result = unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            from.as_ptr(),
            libc::AT_FDCWD,
            to.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(format!(
            "Could not finish download without replacing an existing destination: {}",
            std::io::Error::last_os_error()
        ))
    }
}

#[tauri::command]
pub fn transfer_queue_notice(queue: State<'_, TransferQueue>) -> Option<String> {
    queue.recovery_notice.clone()
}

#[tauri::command]
pub fn list_transfer_jobs(queue: State<'_, TransferQueue>) -> Result<Vec<Job>, String> {
    Ok(queue.jobs.lock().map_err(|e| e.to_string())?.clone())
}

#[tauri::command]
pub fn enqueue_transfer(
    queue: State<'_, TransferQueue>,
    state: State<'_, AppState>,
    server_id: String,
    direction: String,
    local_path: String,
    remote_path: String,
) -> Result<Job, String> {
    let job = Job {
        connection_key: route_key(&state.store, &server_id)?,
        id: uuid::Uuid::new_v4().to_string(),
        server_id,
        direction,
        local_path,
        remote_path,
        overwrite: false,
        status: "queued".into(),
        error: None,
    };
    validate(&job)?;
    queue.update(|jobs| {
        if jobs.len() >= 1024 {
            return Err("Transfer history is full; remove completed entries first".into());
        }
        jobs.push(job.clone());
        Ok(())
    })?;
    Ok(job)
}

#[tauri::command]
pub fn transfer_job_action(
    queue: State<'_, TransferQueue>,
    id: String,
    action: String,
) -> Result<(), String> {
    queue.update(|jobs| {
        let job = jobs
            .iter_mut()
            .find(|j| j.id == id)
            .ok_or("Transfer no longer exists")?;
        if job.status == "invalidated" && action != "forget" {
            return Err("Create a new transfer after restoring the library".into());
        }
        if job.status == "complete" && action != "forget" {
            return Err("This transfer is already complete".into());
        }
        if job.status == "running" {
            return Err("Pause the running transfer first".into());
        }
        match action.as_str() {
            "retry" => {
                job.status = "queued".into();
                job.error = None;
            }
            "replace" if job.direction == "upload" => {
                job.overwrite = true;
                job.status = "queued".into();
                job.error = None;
            }
            "pause" => job.status = "paused".into(),
            "forget" => jobs.retain(|j| j.id != id),
            _ => return Err("Unsupported transfer action".into()),
        }
        Ok(())
    })?;
    Ok(())
}

#[tauri::command(async)]
pub fn run_transfer_job(
    app: AppHandle,
    state: State<'_, AppState>,
    queue: State<'_, TransferQueue>,
    id: String,
    operation_id: Option<String>,
) -> Result<crate::models::TransferProgress, AppError> {
    let job = queue
        .jobs
        .lock()
        .map_err(|e| e.to_string())?
        .iter()
        .find(|j| j.id == id)
        .cloned()
        .ok_or("Transfer no longer exists")?;
    if route_key(&state.store, &job.server_id)? != job.connection_key {
        queue.update(|jobs| { if let Some(job)=jobs.iter_mut().find(|j|j.id==id) {job.status="invalidated".into();job.error=Some("Connection routing or the library changed. Review the connection and create a new transfer.".into());} Ok(()) })?;
        return Err(
            "Connection routing changed; create a new transfer after reviewing its destination"
                .to_string()
                .into(),
        );
    }
    let jobs = queue.update(|jobs| {
        if jobs.iter().any(|j| j.status == "running") {
            return Err("Another transfer is already running".into());
        }
        let job = jobs
            .iter_mut()
            .find(|j| j.id == id && ["queued", "failed", "paused"].contains(&j.status.as_str()))
            .ok_or("Queue this transfer before starting it")?;
        job.status = "running".into();
        Ok(())
    })?;
    let job = jobs.into_iter().find(|j| j.id == id).unwrap();
    // Replace queued controls with Pause as soon as the backend starts work.
    // Waiting until completion leaves the queue modal displaying stale actions.
    let _ = app.emit("transfer-queue-changed", ());
    let result = if job.direction == "upload" {
        crate::providers::upload_path(
            &state.store,
            &job.server_id,
            &job.local_path,
            &job.remote_path,
            job.overwrite,
            app.clone(),
            crate::providers::TransferOptions {
                operation_id: operation_id.as_deref(),
                queue_id: Some(&id),
            },
        )
    } else {
        crate::providers::download_path(
            &state.store,
            &job.server_id,
            &job.remote_path,
            &job.local_path,
            app.clone(),
            crate::providers::TransferOptions {
                operation_id: operation_id.as_deref(),
                queue_id: Some(&id),
            },
        )
    };
    queue.update(|jobs| {
        let job = jobs
            .iter_mut()
            .find(|j| j.id == id)
            .ok_or("Transfer disappeared")?;
        job.status = if result.is_ok() {
            "complete"
        } else if matches!(&result, Err(e) if e == crate::ssh::OPERATION_CANCELLED) {
            "paused"
        } else {
            "failed"
        }
        .into();
        job.error = result
            .as_ref()
            .err()
            .map(|error| error.chars().take(2048).collect());
        Ok(())
    })?;
    let _ = app.emit("transfer-queue-changed", ());
    Ok(result?)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn corrupt_queue_is_retained_without_preventing_terminal_startup() {
        let dir =
            std::env::temp_dir().join(format!("ternway-queue-corrupt-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("transfers.json");
        std::fs::write(&path, b"interrupted fixture data").unwrap();
        let queue = TransferQueue::open_recovering(path.clone()).unwrap();
        assert!(queue.jobs.lock().unwrap().is_empty());
        assert!(queue.recovery_notice.as_ref().unwrap().contains("retained"));
        let saved = std::fs::read_dir(&dir)
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        assert_eq!(std::fs::read(saved).unwrap(), b"interrupted fixture data");
        assert!(!path.exists());
        let _ = std::fs::remove_dir_all(dir);
    }
    #[test]
    fn resume_checks_every_byte_and_rejects_short_or_changed_checkpoints() {
        let data = vec![42; 100000];
        verify_prefix(&mut &data[..], &mut &data[..50000], 50000, None).unwrap();
        let mut changed = data.clone();
        changed[45000] = 0;
        assert!(verify_prefix(&mut &data[..], &mut &changed[..], 50000, None).is_err());
        assert!(verify_prefix(&mut &data[..], &mut &data[..5], 50000, None).is_err());
    }
    #[test]
    fn restart_pauses_intent_and_failed_updates_leave_old_queue_intact() {
        let dir = std::env::temp_dir().join(format!("ternway-queue-{}", uuid::Uuid::new_v4()));
        let path = dir.join("queue.json");
        let queue = TransferQueue::open(path.clone()).unwrap();
        let job = Job {
            connection_key: "fixture".into(),
            id: uuid::Uuid::new_v4().to_string(),
            server_id: "server".into(),
            direction: "upload".into(),
            local_path: "/tmp/local".into(),
            remote_path: "/tmp/remote".into(),
            overwrite: false,
            status: "running".into(),
            error: None,
        };
        queue
            .update(|jobs| {
                jobs.push(job);
                Ok(())
            })
            .unwrap();
        let restored = TransferQueue::open(path).unwrap();
        assert_eq!(restored.jobs.lock().unwrap()[0].status, "paused");
        assert!(restored
            .update(|jobs| {
                jobs.clear();
                Err("fixture".into())
            })
            .is_err());
        assert_eq!(restored.jobs.lock().unwrap().len(), 1);
        let a = dir.join("partial");
        let b = dir.join("destination");
        std::fs::write(&a, b"new").unwrap();
        std::fs::write(&b, b"original").unwrap();
        assert!(commit_download(&a, &b).is_err());
        assert_eq!(std::fs::read(&b).unwrap(), b"original");
        std::fs::remove_file(&b).unwrap();
        commit_download(&a, &b).unwrap();
        assert_eq!(std::fs::read(&b).unwrap(), b"new");
        let _ = std::fs::remove_dir_all(dir);
    }
}
