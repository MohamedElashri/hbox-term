use crate::{models::*, storage::Store, AppError, AppState};
use rusqlite::{params, OptionalExtension};
use tauri::{AppHandle, Emitter, State};

fn source_key(source: &str, alias: &str, draft: &ServerDraft) -> Result<String, String> {
    if source.len() > 8192 || alias.is_empty() || alias.len() > 1024 {
        return Err("Invalid import source".into());
    }
    let source = if source.trim().is_empty() {
        dirs::home_dir()
            .ok_or("Home directory unavailable")?
            .join(".ssh/config")
    } else {
        crate::ssh::expand_path(source)
    };
    let source = source.canonicalize().unwrap_or(source);
    serde_json::to_string(&(
        source.to_string_lossy(),
        alias,
        draft.auth_method == AuthMethod::OpenSsh,
    ))
    .map_err(|e| e.to_string())
}
fn fingerprint(draft: &ServerDraft) -> serde_json::Value {
    serde_json::json!([
        draft.host.to_lowercase(),
        draft.username,
        draft.port,
        draft.auth_method,
        draft.key_path,
        draft.identity_id,
        draft.open_ssh
    ])
}
impl Store {
    pub fn import_connection(
        &self,
        draft: &ServerDraft,
        source: &str,
        alias: &str,
        update: bool,
    ) -> Result<(ServerProfile, bool), String> {
        let _exclusive = self.import_lock.lock().map_err(|e| e.to_string())?;
        if draft.id.is_some()
            || [&draft.password, &draft.key_passphrase, &draft.sudo_password]
                .iter()
                .any(|v| v.as_ref().is_some_and(|s| !s.is_empty()))
            || draft.password_reference.is_some()
        {
            return Err("Config imports cannot contain credentials or arbitrary IDs".into());
        }
        let key = source_key(source, alias, draft)?;
        let existing: Option<String> = self
            .connection
            .lock()
            .map_err(|e| e.to_string())?
            .query_row(
                "SELECT server_id FROM import_origins WHERE source_key=?1",
                [&key],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if let Some(id) = existing {
            let previous = self.get_server(&id)?;
            if !update {
                return Ok((previous, false));
            }
            let mut edited = draft.clone();
            edited.id = Some(id.clone());
            // Explicit reconciliation changes routing/auth only; keep personal organization.
            edited.name = previous.name;
            edited.group_name = previous.group_name;
            edited.tags = previous.tags;
            edited.notes = previous.notes;
            edited.favorite = previous.favorite;
            edited.password = None;
            edited.key_passphrase = None;
            edited.sudo_password = None;
            let saved = self.save_server(&edited)?;
            self.connection
                .lock()
                .map_err(|e| e.to_string())?
                .execute(
                    "UPDATE import_origins SET snapshot_json=?1 WHERE source_key=?2",
                    params![fingerprint(draft).to_string(), key],
                )
                .map_err(|e| e.to_string())?;
            return Ok((saved, false));
        }
        // Adopt an identical existing entry instead of duplicating repeated imports.
        let matching = self.list_servers()?.into_iter().find(|p| {
            serde_json::json!([
                p.host.to_lowercase(),
                p.username,
                p.port,
                p.auth_method,
                p.key_path,
                p.identity_id,
                p.open_ssh
            ]) == fingerprint(draft)
        });
        let created = matching.is_none();
        let saved = if let Some(profile) = matching {
            profile
        } else {
            self.save_server(draft)?
        };
        self.connection
            .lock()
            .map_err(|e| e.to_string())?
            .execute(
                "INSERT INTO import_origins(source_key,server_id,snapshot_json) VALUES(?1,?2,?3)",
                params![key, saved.id, fingerprint(draft).to_string()],
            )
            .map_err(|e| e.to_string())?;
        Ok((saved, created))
    }
    pub fn bulk_metadata(
        &self,
        ids: &[String],
        group: Option<String>,
        tags: Option<Vec<String>>,
        favorite: Option<bool>,
    ) -> Result<(), String> {
        if ids.is_empty() || ids.len() > 10000 {
            return Err("Select between 1 and 10,000 connections".into());
        }
        if group.as_ref().is_some_and(|s| s.len() > 1024)
            || tags
                .as_ref()
                .is_some_and(|v| v.len() > 100 || v.iter().any(|s| s.len() > 256))
        {
            return Err("Group or tags are too long".into());
        }
        let mut db = self.connection.lock().map_err(|e| e.to_string())?;
        let tx = db.transaction().map_err(|e| e.to_string())?;
        for id in ids {
            let exists: bool = tx
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM servers WHERE id=?1)",
                    [id],
                    |r| r.get(0),
                )
                .map_err(|e| e.to_string())?;
            if !exists {
                return Err("A selected connection no longer exists; nothing was changed".into());
            }
            if let Some(group) = &group {
                tx.execute(
                    "UPDATE servers SET group_name=NULLIF(trim(?1),''),updated_at=?2 WHERE id=?3",
                    params![group, chrono::Utc::now().to_rfc3339(), id],
                )
                .map_err(|e| e.to_string())?;
            }
            if let Some(tags) = &tags {
                let tags: std::collections::BTreeSet<_> = tags
                    .iter()
                    .map(|s| s.trim())
                    .filter(|s| !s.is_empty())
                    .collect();
                tx.execute(
                    "UPDATE servers SET tags_json=?1,updated_at=?2 WHERE id=?3",
                    params![
                        serde_json::to_string(&tags).map_err(|e| e.to_string())?,
                        chrono::Utc::now().to_rfc3339(),
                        id
                    ],
                )
                .map_err(|e| e.to_string())?;
            }
            if let Some(favorite) = favorite {
                tx.execute(
                    "UPDATE servers SET favorite=?1,updated_at=?2 WHERE id=?3",
                    params![favorite, chrono::Utc::now().to_rfc3339(), id],
                )
                .map_err(|e| e.to_string())?;
            }
        }
        tx.commit().map_err(|e| e.to_string())
    }
}
#[tauri::command(async)]
pub fn inspect_import_source(
    state: State<'_, AppState>,
    source: String,
    aliases: Vec<String>,
) -> Result<serde_json::Value, AppError> {
    if aliases.len() > 10000 {
        return Err("Too many aliases".to_string().into());
    }
    let path = if source.trim().is_empty() {
        dirs::home_dir()
            .ok_or("Home directory unavailable")?
            .join(".ssh/config")
    } else {
        crate::ssh::expand_path(&source)
    };
    let path = path
        .canonicalize()
        .unwrap_or(path)
        .to_string_lossy()
        .to_string();
    let db = state.store.connection.lock().map_err(|e| e.to_string())?;
    let mut stmt = db
        .prepare("SELECT source_key FROM import_origins")
        .map_err(|e| e.to_string())?;
    let mut existing = std::collections::BTreeSet::new();
    let mut missing = std::collections::BTreeSet::new();
    for key in stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
    {
        if let Ok((origin, alias, _)) =
            serde_json::from_str::<(String, String, bool)>(&key.map_err(|e| e.to_string())?)
        {
            if origin == path {
                if aliases.contains(&alias) {
                    existing.insert(alias);
                } else {
                    missing.insert(alias);
                }
            }
        }
    }
    Ok(serde_json::json!({"existing":existing,"missing":missing}))
}

#[tauri::command(async)]
pub fn import_connection(
    app: AppHandle,
    state: State<'_, AppState>,
    draft: ServerDraft,
    source: String,
    alias: String,
    update_existing: bool,
) -> Result<serde_json::Value, AppError> {
    let before = state.store.list_servers()?;
    let (server, created) =
        state
            .store
            .import_connection(&draft, &source, &alias, update_existing)?;
    if before
        .iter()
        .find(|p| p.id == server.id)
        .is_some_and(|p| crate::ssh::profile_key(p) != crate::ssh::profile_key(&server))
    {
        crate::close_server_activity(
            &state,
            &crate::affected_server_ids(&state.store, &server.id)?,
        )?;
    }
    let _ = app.emit("library-changed", ());
    Ok(serde_json::json!({"server":server,"created":created}))
}
#[tauri::command(async)]
pub fn bulk_connection_metadata(
    app: AppHandle,
    state: State<'_, AppState>,
    ids: Vec<String>,
    group: Option<String>,
    tags: Option<Vec<String>>,
    favorite: Option<bool>,
) -> Result<(), AppError> {
    state.store.bulk_metadata(&ids, group, tags, favorite)?;
    let _ = app.emit("library-changed", ());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn repeated_import_reconciles_without_duplicate_or_personal_metadata_loss() {
        let dir = std::env::temp_dir().join(format!("ternway-import-{}", uuid::Uuid::new_v4()));
        let store = Store::open(&dir.join("db"), &dir.join("vault")).unwrap();
        let mut draft: ServerDraft = serde_json::from_value(serde_json::json!({"name":"qa","host":"first","username":"qa","port":22,"groupName":"Personal"})).unwrap();
        let (first, created) = store
            .import_connection(&draft, "/tmp/config", "qa", false)
            .unwrap();
        assert!(created);
        assert!(
            !store
                .import_connection(&draft, "/tmp/config", "qa", false)
                .unwrap()
                .1
        );
        draft.host = "second".into();
        draft.group_name = Some("Imported".into());
        assert_eq!(
            store
                .import_connection(&draft, "/tmp/config", "qa", false)
                .unwrap()
                .0
                .host,
            "first"
        );
        let updated = store
            .import_connection(&draft, "/tmp/config", "qa", true)
            .unwrap()
            .0;
        assert_eq!(updated.id, first.id);
        assert_eq!(updated.host, "second");
        assert_eq!(updated.group_name.as_deref(), Some("Personal"));
        assert_eq!(store.list_servers().unwrap().len(), 1);
        assert!(store
            .bulk_metadata(
                &[first.id.clone(), "missing".into()],
                Some("wrong".into()),
                None,
                None
            )
            .is_err());
        assert_eq!(
            store.get_server(&first.id).unwrap().group_name.as_deref(),
            Some("Personal")
        );
        store
            .bulk_metadata(
                &[first.id.clone()],
                Some("Work".into()),
                Some(vec!["api".into(), "api".into()]),
                Some(true),
            )
            .unwrap();
        let saved = store.get_server(&first.id).unwrap();
        assert_eq!(saved.tags, vec!["api"]);
        assert!(saved.favorite);
        let _ = std::fs::remove_dir_all(dir);
    }
}
