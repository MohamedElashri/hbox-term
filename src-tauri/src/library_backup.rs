//! Versioned data, never SQL or plaintext secrets. A journal coordinates SQLite and vault restore.
use crate::{storage::Store, AppError, AppState};
use base64::{engine::general_purpose::STANDARD, Engine};
use rusqlite::{
    params_from_iter,
    types::{Value as SqlValue, ValueRef},
    Connection,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, path::Path};
use tauri::{AppHandle, Emitter, Manager, State};

const TABLES: &[(&str,&str)] = &[
    ("identities","id,name,username,provider,reference"),
    ("servers","id,name,host,username,port,auth_method,key_path,group_name,tags_json,favorite,created_at,updated_at,last_connected_at,jump_host_id"),
    ("server_notes","server_id,notes,updated_at"),
    ("connection_identities","server_id,identity_id"),
    ("openssh_connections","server_id,reference_json"),
    ("password_references","server_id,reference_json"),
    ("import_origins","source_key,server_id,snapshot_json"),
    ("saved_commands","id,server_id,name,command"),
    ("tunnels","id,server_id,name,kind,bind_host,bind_port,target_host,target_port"),
];
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Backup {
    format: String,
    version: u32,
    tables: BTreeMap<String, Vec<Vec<serde_json::Value>>>,
    encrypted_vault: Option<String>,
}
#[derive(Serialize, Deserialize)]
struct Journal {
    token: String,
    old_vault: Option<String>,
    new_vault: Option<String>,
}
fn decode(value: &Option<String>) -> Result<Option<Vec<u8>>, String> {
    value
        .as_ref()
        .map(|v| {
            STANDARD
                .decode(v)
                .map_err(|_| "Invalid encrypted vault encoding".into())
        })
        .transpose()
}
fn bounded_read(path: &Path) -> Result<Vec<u8>, String> {
    let meta = std::fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if !meta.is_file() || meta.len() > 16 * 1024 * 1024 {
        return Err("Backup must be a regular file smaller than 16 MiB".into());
    }
    std::fs::read(path).map_err(|e| e.to_string())
}
fn read(path: &Path) -> Result<(Backup, String), String> {
    let bytes = bounded_read(path)?;
    let checksum = format!("{:x}", Sha256::digest(&bytes));
    let backup: Backup =
        serde_json::from_slice(&bytes).map_err(|_| "Invalid Ternway backup".to_string())?;
    if backup.format != "ternway-library"
        || backup.version != 1
        || backup.tables.len() != TABLES.len()
    {
        return Err("Unsupported Ternway backup format or version".into());
    }
    if backup.tables.values().map(Vec::len).sum::<usize>() > 25000 {
        return Err("Backup has too many entries".into());
    }
    for (table, columns) in TABLES {
        let rows = backup.tables.get(*table).ok_or("Missing backup table")?;
        if rows.iter().any(|row| {
            row.len() != columns.split(',').count()
                || row
                    .iter()
                    .any(|v| !v.is_null() && !v.is_string() && !v.is_i64())
        }) {
            return Err("Invalid backup field or row".into());
        }
    }
    Ok((backup, checksum))
}
fn dump(db: &Connection, vault: Option<Vec<u8>>) -> Result<Backup, String> {
    let mut tables = BTreeMap::new();
    for (table, columns) in TABLES {
        let count = columns.split(',').count();
        let mut stmt = db
            .prepare(&format!("SELECT {columns} FROM {table}"))
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                (0..count)
                    .map(|i| {
                        Ok(match row.get_ref(i)? {
                            ValueRef::Null => serde_json::Value::Null,
                            ValueRef::Integer(v) => serde_json::json!(v),
                            ValueRef::Text(v) => serde_json::json!(String::from_utf8_lossy(v)),
                            _ => return Err(rusqlite::Error::InvalidQuery),
                        })
                    })
                    .collect::<rusqlite::Result<Vec<_>>>()
            })
            .map_err(|e| e.to_string())?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| e.to_string())?;
        tables.insert((*table).into(), rows);
    }
    Ok(Backup {
        format: "ternway-library".into(),
        version: 1,
        tables,
        encrypted_vault: vault.map(|v| STANDARD.encode(v)),
    })
}
fn apply(db: &Connection, backup: &Backup) -> Result<(), String> {
    db.execute_batch("PRAGMA defer_foreign_keys=ON; DELETE FROM servers; DELETE FROM identities; DELETE FROM saved_commands; DELETE FROM tunnels;").map_err(|e|e.to_string())?;
    for (table, columns) in TABLES {
        let params = (1..=columns.split(',').count())
            .map(|n| format!("?{n}"))
            .collect::<Vec<_>>()
            .join(",");
        let mut insert = db
            .prepare(&format!("INSERT INTO {table}({columns}) VALUES({params})"))
            .map_err(|e| e.to_string())?;
        for row in backup.tables.get(*table).ok_or("Missing backup table")? {
            let values = row.iter().map(|v| {
                if let Some(s) = v.as_str() {
                    SqlValue::Text(s.into())
                } else if let Some(i) = v.as_i64() {
                    SqlValue::Integer(i)
                } else {
                    SqlValue::Null
                }
            });
            insert
                .execute(params_from_iter(values))
                .map_err(|_| format!("Invalid or conflicting entries in backup {table}"))?;
        }
    }
    for row in &backup.tables["password_references"] {
        let reference: crate::secret_provider::PasswordReference =
            serde_json::from_str(row[1].as_str().ok_or("Invalid password reference")?)
                .map_err(|_| "Invalid password reference".to_string())?;
        reference.validate()?;
    }
    for row in &backup.tables["openssh_connections"] {
        let reference: crate::models::OpenSshConfig =
            serde_json::from_str(row[1].as_str().ok_or("Invalid OpenSSH reference")?)
                .map_err(|_| "Invalid OpenSSH reference".to_string())?;
        crate::openssh::validate_reference(&reference)?;
    }
    for identity in crate::identities::list(db)? {
        crate::identities::save(db, &identity)?;
    }
    let invalid:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM servers WHERE length(trim(id))=0 OR length(trim(name))=0 OR length(trim(host))=0 OR port<1 OR port>65535 OR auth_method NOT IN ('password','privateKey','sshAgent','openSsh'))",[],|r|r.get(0)).map_err(|e|e.to_string())?;
    if invalid {
        return Err("Invalid connection in backup".into());
    }
    let foreign: Option<i64> = db
        .prepare("PRAGMA foreign_key_check")
        .map_err(|e| e.to_string())?
        .query_map([], |r| r.get(1))
        .map_err(|e| e.to_string())?
        .next()
        .transpose()
        .map_err(|e| e.to_string())?;
    if foreign.is_some() {
        return Err("Backup references a missing connection or identity".into());
    }
    Ok(())
}
pub fn recover_restore(db: &Connection, vault_path: &Path) -> Result<(), String> {
    let path = vault_path.with_extension("restore-journal");
    if !path.exists() {
        return Ok(());
    }
    let journal: Journal = serde_json::from_slice(&bounded_read(&path)?)
        .map_err(|_| "Invalid restore journal; keep it for recovery".to_string())?;
    let committed: bool = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM restore_marker WHERE token=?1)",
            [journal.token],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let bytes = decode(if committed {
        &journal.new_vault
    } else {
        &journal.old_vault
    })?;
    crate::credentials::replace_encrypted_file(vault_path, bytes.as_deref())?;
    std::fs::remove_file(path).map_err(|e| e.to_string())
}
impl Store {
    pub fn export_backup(&self, path: &Path, secrets: bool) -> Result<(), String> {
        let _mutation = self.mutation_lock.lock().map_err(|e| e.to_string())?;
        let db = self.connection.lock().map_err(|e| e.to_string())?;
        let backup = dump(
            &db,
            if secrets {
                self.credentials.encrypted_snapshot()?
            } else {
                None
            },
        )?;
        crate::layout_files::private_write(
            path,
            &serde_json::to_vec(&backup).map_err(|e| e.to_string())?,
        )
    }
    pub fn restore_backup(
        &self,
        path: &Path,
        checksum: &str,
        recovery_path: &Path,
    ) -> Result<(), String> {
        let _mutation = self.mutation_lock.lock().map_err(|e| e.to_string())?;
        let (backup, actual) = read(path)?;
        if actual != checksum {
            return Err("Backup changed since preview; review it again".into());
        }
        let new_vault = decode(&backup.encrypted_vault)?;
        let mut db = self.connection.lock().map_err(|e| e.to_string())?;
        let old_vault = self.credentials.encrypted_snapshot()?;
        let previous = dump(&db, old_vault.clone())?;
        let tx = db.transaction().map_err(|e| e.to_string())?;
        apply(&tx, &backup)?;
        // All validation precedes persistent changes. The automatic backup is recoverable.
        crate::layout_files::private_write(
            recovery_path,
            &serde_json::to_vec(&previous).map_err(|e| e.to_string())?,
        )?;
        let token = uuid::Uuid::new_v4().to_string();
        tx.execute("DELETE FROM restore_marker", [])
            .map_err(|e| e.to_string())?;
        tx.execute("INSERT INTO restore_marker(token) VALUES(?1)", [&token])
            .map_err(|e| e.to_string())?;
        let journal_path = self.credentials.journal_path()?;
        let journal = Journal {
            token,
            old_vault: old_vault.as_ref().map(|b| STANDARD.encode(b)),
            new_vault: backup.encrypted_vault,
        };
        crate::layout_files::private_write(
            &journal_path,
            &serde_json::to_vec(&journal).map_err(|e| e.to_string())?,
        )?;
        if let Err(error) = self.credentials.replace_encrypted(new_vault.as_deref()) {
            let _ = self.credentials.replace_encrypted(old_vault.as_deref());
            return Err(error);
        }
        if let Err(error) = tx.commit() {
            self.credentials.replace_encrypted(old_vault.as_deref())?;
            let _ = std::fs::remove_file(journal_path);
            return Err(error.to_string());
        }
        self.lock_credentials();
        std::fs::remove_file(journal_path).map_err(|e| e.to_string())
    }
}
#[tauri::command(async)]
pub fn export_library_backup(
    state: State<'_, AppState>,
    path: String,
    include_secrets: bool,
) -> Result<(), AppError> {
    Ok(state
        .store
        .export_backup(&crate::ssh::expand_path(&path), include_secrets)?)
}
#[tauri::command(async)]
pub fn preview_library_backup(path: String) -> Result<serde_json::Value, AppError> {
    let (backup, checksum) = read(&crate::ssh::expand_path(&path))?;
    Ok(
        serde_json::json!({"connections":backup.tables["servers"].len(),"identities":backup.tables["identities"].len(),"includesSecrets":backup.encrypted_vault.is_some(),"checksum":checksum}),
    )
}
#[tauri::command(async)]
pub fn restore_library_backup(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
    checksum: String,
    queue: State<'_, crate::transfer_queue::TransferQueue>,
    edits: State<'_, crate::remote_edit::RemoteEdits>,
) -> Result<String, AppError> {
    if crate::remote_edit::has_active(&edits) {
        return Err("Close active remote-file editors before restoring the library; unsaved copies remain recoverable".to_string().into());
    }
    let recovery = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join("backups")
        .join(format!("before-restore-{}.json", uuid::Uuid::new_v4()));
    queue.restore_library(|| {
        state
            .store
            .restore_backup(&crate::ssh::expand_path(&path), &checksum, &recovery)
    })?;
    crate::tunnels::stop_all();
    crate::terminal::close_remote(&state.terminals);
    crate::log_stream::close_all(&state.log_streams);
    crate::ssh::disconnect_all();
    let _ = app.emit("vault-locked", ());
    let _ = app.emit("library-changed", ());
    Ok(recovery.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn backup_roundtrip_is_versioned_secret_opt_in_and_restore_is_transactional() {
        let dir = std::env::temp_dir().join(format!("ternway-backup-{}", uuid::Uuid::new_v4()));
        let store = Store::open(&dir.join("db"), &dir.join("vault")).unwrap();
        store.unlock_credentials("fixture vault password").unwrap();
        let draft:crate::models::ServerDraft=serde_json::from_value(serde_json::json!({"name":"QA","host":"localhost","username":"qa","port":22,"password":"fixture SSH secret"})).unwrap();
        let server = store.save_server(&draft).unwrap();
        let metadata = dir.join("metadata.json");
        let full = dir.join("full.json");
        store.export_backup(&metadata, false).unwrap();
        store.export_backup(&full, true).unwrap();
        assert!(read(&metadata).unwrap().0.encrypted_vault.is_none());
        assert!(read(&full).unwrap().0.encrypted_vault.is_some());
        assert!(!String::from_utf8(std::fs::read(&full).unwrap())
            .unwrap()
            .contains("fixture SSH secret"));
        let (_, checksum) = read(&full).unwrap();
        store
            .restore_backup(&full, &checksum, &dir.join("rollback.json"))
            .unwrap();
        assert!(!store.credential_status().unlocked);
        store.unlock_credentials("fixture vault password").unwrap();
        assert_eq!(
            store.get_secret(&server.id, "password").unwrap().as_deref(),
            Some("fixture SSH secret")
        );
        let (mut invalid, _) = read(&full).unwrap();
        invalid.tables.get_mut("servers").unwrap()[0][4] = serde_json::json!(999999);
        let corrupt = dir.join("invalid.json");
        crate::layout_files::private_write(&corrupt, &serde_json::to_vec(&invalid).unwrap())
            .unwrap();
        let (_, hash) = read(&corrupt).unwrap();
        let before = store.list_servers().unwrap();
        assert!(store
            .restore_backup(&corrupt, &hash, &dir.join("unused.json"))
            .is_err());
        assert_eq!(store.list_servers().unwrap()[0].id, before[0].id);
        assert!(!dir.join("unused.json").exists());
        assert!(store
            .restore_backup(&full, "wrong-checksum", &dir.join("unused.json"))
            .is_err());
        let (_, hash) = read(&metadata).unwrap();
        store
            .restore_backup(&metadata, &hash, &dir.join("before-metadata.json"))
            .unwrap();
        assert!(!store.credential_status().configured);
        assert!(read(&dir.join("before-metadata.json"))
            .unwrap()
            .0
            .encrypted_vault
            .is_some());
        invalid.version = 999;
        crate::layout_files::private_write(&corrupt, &serde_json::to_vec(&invalid).unwrap())
            .unwrap();
        assert!(read(&corrupt).is_err());
        let _ = std::fs::remove_dir_all(dir);
    }
    #[test]
    fn crash_journal_selects_vault_that_matches_committed_database() {
        let dir = std::env::temp_dir().join(format!("ternway-journal-{}", uuid::Uuid::new_v4()));
        let path = dir.join("vault");
        let store = Store::open(&dir.join("db"), &path).unwrap();
        store.unlock_credentials("fixture vault password").unwrap();
        let draft:crate::models::ServerDraft=serde_json::from_value(serde_json::json!({"name":"qa","host":"localhost","username":"qa","port":22,"password":"saved"})).unwrap();
        store.save_server(&draft).unwrap();
        let original = store.credentials.encrypted_snapshot().unwrap().unwrap();
        for committed in [false, true] {
            let token = uuid::Uuid::new_v4().to_string();
            let journal = Journal {
                token: token.clone(),
                old_vault: Some(STANDARD.encode(&original)),
                new_vault: None,
            };
            crate::layout_files::private_write(
                &path.with_extension("restore-journal"),
                &serde_json::to_vec(&journal).unwrap(),
            )
            .unwrap();
            let db = store.connection.lock().unwrap();
            if committed {
                db.execute("INSERT INTO restore_marker(token) VALUES(?1)", [token])
                    .unwrap();
            }
            recover_restore(&db, &path).unwrap();
            assert_eq!(path.exists(), !committed);
        }
        let _ = std::fs::remove_dir_all(dir);
    }
}
