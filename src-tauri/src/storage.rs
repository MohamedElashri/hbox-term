use crate::credentials::CredentialStore;
use crate::models::{AuthMethod, ServerDraft, ServerProfile};
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use uuid::Uuid;
use zeroize::Zeroizing;

#[derive(Clone)]
pub struct Store {
    connection: Arc<Mutex<Connection>>,
    credentials: CredentialStore,
    session_passwords: Arc<Mutex<HashMap<String, Zeroizing<String>>>>,
}

impl Store {
    pub fn set_connection_group(
        &self,
        server_ids: &[String],
        group_name: &str,
    ) -> Result<(), String> {
        let mut connection = self.connection.lock().map_err(|e| e.to_string())?;
        let transaction = connection.transaction().map_err(|e| e.to_string())?;
        let group = group_name.trim();
        for id in server_ids {
            let changed = transaction
                .execute(
                    "UPDATE servers SET group_name = ?1, updated_at = ?2 WHERE id = ?3",
                    params![
                        if group.is_empty() { None } else { Some(group) },
                        Utc::now().to_rfc3339(),
                        id
                    ],
                )
                .map_err(|e| e.to_string())?;
            if changed != 1 {
                return Err("Connection no longer exists; no groups were changed".into());
            }
        }
        transaction.commit().map_err(|e| e.to_string())
    }

    pub fn open(path: &Path, credentials_path: &Path) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("Could not create ternway data directory: {error}"))?;
        }
        let mut connection = Connection::open(path)
            .map_err(|error| format!("Could not open ternway database: {error}"))?;
        connection
            .execute_batch(
                "PRAGMA foreign_keys = ON;
                 CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);
                 CREATE TABLE IF NOT EXISTS servers (
                    id TEXT PRIMARY KEY NOT NULL,
                    name TEXT NOT NULL,
                    host TEXT NOT NULL,
                    username TEXT NOT NULL,
                    port INTEGER NOT NULL,
                    auth_method TEXT NOT NULL,
                    key_path TEXT,
                    group_name TEXT,
                    tags_json TEXT NOT NULL DEFAULT '[]',
                    favorite INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    last_connected_at TEXT,
                    jump_host_id TEXT REFERENCES servers(id) ON DELETE SET NULL
                 );
                 CREATE TABLE IF NOT EXISTS server_notes (
                    server_id TEXT PRIMARY KEY NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
                    notes TEXT NOT NULL DEFAULT '',
                    updated_at TEXT NOT NULL
                 );
                 CREATE TABLE IF NOT EXISTS saved_commands (
                    id TEXT PRIMARY KEY NOT NULL,
                    server_id TEXT REFERENCES servers(id) ON DELETE CASCADE,
                    name TEXT NOT NULL,
                    command TEXT NOT NULL
                 );
                 CREATE TABLE IF NOT EXISTS tunnels (
                    id TEXT PRIMARY KEY NOT NULL,
                    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
                    name TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    bind_host TEXT NOT NULL,
                    bind_port INTEGER NOT NULL,
                    target_host TEXT NOT NULL,
                    target_port INTEGER NOT NULL
                 );
                 INSERT INTO schema_version(version)
                 SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM schema_version);",
            )
            .map_err(|error| format!("Could not initialize ternway database: {error}"))?;
        let has_jump_host = {
            let mut statement = connection
                .prepare("PRAGMA table_info(servers)")
                .map_err(|error| format!("Could not inspect ternway database: {error}"))?;
            let columns = statement
                .query_map([], |row| row.get::<_, String>(1))
                .map_err(|error| format!("Could not inspect ternway database: {error}"))?;
            columns
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(|error| format!("Could not inspect ternway database: {error}"))?
                .iter()
                .any(|column| column == "jump_host_id")
        };
        if !has_jump_host {
            connection
                .execute(
                    "ALTER TABLE servers ADD COLUMN jump_host_id TEXT REFERENCES servers(id) ON DELETE SET NULL",
                    [],
                )
                .map_err(|error| format!("Could not add bastion support to ternway database: {error}"))?;
        }
        crate::identities::migrate(&mut connection, path)?;
        connection
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS password_references (server_id TEXT PRIMARY KEY NOT NULL REFERENCES servers(id) ON DELETE CASCADE, reference_json TEXT NOT NULL);
                 CREATE TABLE IF NOT EXISTS openssh_connections (
            server_id TEXT PRIMARY KEY NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
            reference_json TEXT NOT NULL
        );",
            )
            .map_err(|e| format!("Could not initialize OpenSSH connections: {e}"))?;
        Ok(Self {
            connection: Arc::new(Mutex::new(connection)),
            credentials: CredentialStore::open(credentials_path)?,
            session_passwords: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    pub fn list_identities(&self) -> Result<Vec<crate::identities::Identity>, String> {
        let db = self.connection.lock().map_err(|e| e.to_string())?;
        crate::identities::list(&db)
    }

    pub fn create_identity(&self, identity: &crate::identities::Identity) -> Result<(), String> {
        if identity.provider != crate::identities::IdentityProvider::SshAgent {
            return Err("Only SSH agent identities are supported yet".into());
        }
        crate::identities::validate_agent_reference(&identity.reference)?;
        let db = self.connection.lock().map_err(|e| e.to_string())?;
        if crate::identities::list(&db)?
            .iter()
            .any(|i| i.id == identity.id)
        {
            return Err("Create a new identity to change authentication settings".into());
        }
        crate::identities::save(&db, identity)
    }

    pub fn delete_identity(&self, id: &str) -> Result<(), String> {
        let db = self.connection.lock().map_err(|e| e.to_string())?;
        crate::identities::delete(&db, id)
    }

    pub fn resolve_identity(&self, id: &str) -> Result<crate::identities::Identity, String> {
        self.list_identities()?
            .into_iter()
            .find(|i| i.id == id)
            .ok_or_else(|| "The selected identity no longer exists".into())
    }

    pub fn lock_credentials(&self) {
        self.credentials.lock();
        if let Ok(mut passwords) = self.session_passwords.lock() {
            passwords.clear();
        }
    }

    pub fn credential_activity(&self) {
        self.credentials.activity();
    }

    pub fn lock_if_idle(&self) -> bool {
        let active = self.credentials.status().unlocked
            || self.session_passwords.lock().is_ok_and(|p| !p.is_empty());
        if active && self.credentials.idle() {
            self.lock_credentials();
            true
        } else {
            false
        }
    }

    pub fn credential_status(&self) -> crate::models::CredentialStatus {
        self.credentials.status()
    }

    pub fn unlock_credentials(
        &self,
        password: &str,
    ) -> Result<crate::models::CredentialStatus, String> {
        self.credentials.unlock(password)
    }

    pub fn change_master_password(
        &self,
        current: &str,
        new: &str,
    ) -> Result<crate::models::CredentialStatus, String> {
        let status = self.credentials.change_master_password(current, new)?;
        self.session_passwords
            .lock()
            .map_err(|e| e.to_string())?
            .clear();
        Ok(status)
    }

    pub fn reset_credentials(&self, password: &str) -> Result<(), String> {
        self.credentials.reset(password)?;
        self.session_passwords
            .lock()
            .map_err(|e| e.to_string())?
            .clear();
        Ok(())
    }

    pub(crate) fn set_ssh_password(
        &self,
        server_id: &str,
        password: &str,
        remember: bool,
    ) -> Result<(), String> {
        let profile = self.get_server(server_id)?;
        if !matches!(profile.auth_method, AuthMethod::Password) {
            return Err("This connection does not use password authentication".into());
        }
        if password.is_empty() {
            return Err("Enter the SSH password".into());
        }
        if remember {
            self.credentials
                .update_server(server_id, false, Some(password), None, None)?;
        }
        self.credential_activity();
        self.session_passwords
            .lock()
            .map_err(|e| e.to_string())?
            .insert(server_id.to_owned(), Zeroizing::new(password.to_owned()));
        Ok(())
    }

    pub(crate) fn forget_session_password(&self, server_id: &str) {
        if let Ok(mut passwords) = self.session_passwords.lock() {
            passwords.remove(server_id);
        }
    }

    pub(crate) fn get_secret(&self, server_id: &str, slot: &str) -> Result<Option<String>, String> {
        if slot == "password" {
            if let Some(password) = self
                .session_passwords
                .lock()
                .map_err(|e| e.to_string())?
                .get(server_id)
            {
                return Ok(Some(password.to_string()));
            }
        }
        self.credentials.get(server_id, slot)
    }

    pub fn list_servers(&self) -> Result<Vec<ServerProfile>, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "ternway database lock was poisoned".to_string())?;
        let mut statement = connection
            .prepare(
                "SELECT id, name, host, username, port, auth_method, key_path, group_name,
                        tags_json, favorite, created_at, updated_at, last_connected_at,
                        jump_host_id,
                        COALESCE((SELECT notes FROM server_notes WHERE server_id = servers.id), ''),
                        (SELECT identity_id FROM connection_identities WHERE server_id = servers.id),
                        (SELECT reference_json FROM openssh_connections WHERE server_id = servers.id),
                        (SELECT reference_json FROM password_references WHERE server_id = servers.id)
                 FROM servers ORDER BY favorite DESC, name COLLATE NOCASE ASC",
            )
            .map_err(|error| format!("Could not read servers: {error}"))?;
        let rows = statement
            .query_map([], row_to_server)
            .map_err(|error| format!("Could not read servers: {error}"))?;
        rows.map(|row| row.map_err(|error| format!("Could not decode server: {error}")))
            .collect()
    }

    pub fn get_server(&self, id: &str) -> Result<ServerProfile, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "ternway database lock was poisoned".to_string())?;
        connection
            .query_row(
                "SELECT id, name, host, username, port, auth_method, key_path, group_name,
                        tags_json, favorite, created_at, updated_at, last_connected_at,
                        jump_host_id,
                        COALESCE((SELECT notes FROM server_notes WHERE server_id = servers.id), ''),
                        (SELECT identity_id FROM connection_identities WHERE server_id = servers.id),
                        (SELECT reference_json FROM openssh_connections WHERE server_id = servers.id),
                        (SELECT reference_json FROM password_references WHERE server_id = servers.id)
                 FROM servers WHERE id = ?1",
                [id],
                row_to_server,
            )
            .optional()
            .map_err(|error| format!("Could not read server: {error}"))?
            .ok_or_else(|| "That server no longer exists".to_string())
    }

    pub fn save_server(&self, draft: &ServerDraft) -> Result<ServerProfile, String> {
        let name = required(&draft.name, "server name")?;
        if let Some(reference) = &draft.password_reference {
            reference.validate()?;
            if draft.auth_method != AuthMethod::Password
                || draft.password.as_ref().is_some_and(|p| !p.is_empty())
            {
                return Err("A password reference requires Password authentication and an empty saved-password field".into());
            }
        }
        let open_ssh = if draft.auth_method == AuthMethod::OpenSsh {
            if draft.jump_host_id.is_some()
                || [&draft.password, &draft.key_passphrase, &draft.sudo_password]
                    .into_iter()
                    .any(|v| v.as_ref().is_some_and(|v| !v.is_empty()))
            {
                return Err("OpenSSH connections use configuration routing and terminal authentication, not managed credentials".into());
            }
            Some(crate::openssh::validate_reference(
                draft
                    .open_ssh
                    .as_ref()
                    .ok_or("Choose an OpenSSH host alias")?,
            )?)
        } else {
            None
        };
        let host = if let Some(reference) = &open_ssh {
            reference.alias.clone()
        } else {
            required(&draft.host, "host")?
        };
        let identity = if draft.auth_method == AuthMethod::SshAgent {
            let identity = self.resolve_identity(
                draft
                    .identity_id
                    .as_deref()
                    .ok_or("Choose an SSH agent identity")?,
            )?;
            if identity.provider != crate::identities::IdentityProvider::SshAgent {
                return Err("This identity does not support SSH agent authentication".into());
            }
            Some(identity)
        } else {
            None
        };
        let username = if open_ssh.is_some() {
            String::new()
        } else {
            required(
                identity
                    .as_ref()
                    .map(|i| i.username.as_str())
                    .unwrap_or(&draft.username),
                "username",
            )?
        };
        if !(1..=u16::MAX as u32).contains(&draft.port) {
            return Err("Port must be between 1 and 65535".to_string());
        }
        let port = draft.port as u16;
        let now = Utc::now().to_rfc3339();
        let id = draft
            .id
            .clone()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let jump_host_id = draft
            .jump_host_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());
        self.validate_jump_host(&id, jump_host_id)?;
        let existing = self.get_server(&id).ok();
        let created_at = existing
            .as_ref()
            .map(|server| server.created_at.clone())
            .unwrap_or_else(|| now.clone());
        let tags: Vec<String> = draft
            .tags
            .iter()
            .map(|tag| tag.trim().trim_start_matches('#').to_lowercase())
            .filter(|tag| !tag.is_empty())
            .collect();
        let tags_json = serde_json::to_string(&tags).map_err(|error| error.to_string())?;
        if draft.notes.len() > 100_000 {
            return Err("Server notes are limited to 100 KB".to_string());
        }
        let auth_method = match draft.auth_method {
            AuthMethod::Password => "password",
            AuthMethod::PrivateKey => "privateKey",
            AuthMethod::SshAgent => "sshAgent",
            AuthMethod::OpenSsh => "openSsh",
        };
        let is_new = existing.is_none();
        let has_new_secret = [
            draft.password.as_deref(),
            draft.key_passphrase.as_deref(),
            draft.sudo_password.as_deref(),
        ]
        .into_iter()
        .flatten()
        .any(|secret| !secret.is_empty());
        let updates_existing_credentials = !is_new
            && (draft.password.is_some()
                || draft.key_passphrase.is_some()
                || draft.sudo_password.is_some());
        let clears_possible_stale_credentials = is_new && draft.id.is_some();
        let updates_credentials =
            has_new_secret || updates_existing_credentials || clears_possible_stale_credentials;
        if updates_credentials {
            self.credentials.ensure_unlocked()?;
        }
        let connection = self
            .connection
            .lock()
            .map_err(|_| "ternway database lock was poisoned".to_string())?;
        let tx = connection
            .unchecked_transaction()
            .map_err(|e| e.to_string())?;
        tx.execute(
            "INSERT INTO servers
                    (id, name, host, username, port, auth_method, key_path, group_name,
                     tags_json, favorite, created_at, updated_at, last_connected_at, jump_host_id)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
                 ON CONFLICT(id) DO UPDATE SET
                    name = excluded.name,
                    host = excluded.host,
                    username = excluded.username,
                    port = excluded.port,
                    auth_method = excluded.auth_method,
                    key_path = excluded.key_path,
                    group_name = excluded.group_name,
                    tags_json = excluded.tags_json,
                    favorite = excluded.favorite,
                    jump_host_id = excluded.jump_host_id,
                    updated_at = excluded.updated_at",
            params![
                id,
                name,
                host,
                username,
                port,
                auth_method,
                draft.key_path.as_deref(),
                draft
                    .group_name
                    .as_deref()
                    .filter(|value| !value.trim().is_empty()),
                tags_json,
                draft.favorite,
                created_at,
                now,
                existing
                    .as_ref()
                    .and_then(|server| server.last_connected_at.as_deref()),
                jump_host_id,
            ],
        )
        .map_err(|error| format!("Could not save server: {error}"))?;
        tx
            .execute(
                "INSERT INTO server_notes(server_id, notes, updated_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT(server_id) DO UPDATE SET notes=excluded.notes, updated_at=excluded.updated_at",
                params![id, draft.notes, now],
            )
            .map_err(|error| format!("Could not save server notes: {error}"))?;
        crate::identities::assign(&tx, &id, identity.as_ref().map(|i| i.id.as_str()))?;
        if let Some(reference) = &open_ssh {
            tx.execute(
                "INSERT INTO openssh_connections (server_id, reference_json) VALUES (?1, ?2)
                ON CONFLICT(server_id) DO UPDATE SET reference_json=excluded.reference_json",
                params![
                    id,
                    serde_json::to_string(reference).map_err(|e| e.to_string())?
                ],
            )
            .map_err(|e| e.to_string())?;
        } else {
            tx.execute("DELETE FROM openssh_connections WHERE server_id=?1", [&id])
                .map_err(|e| e.to_string())?;
        }
        if let Some(reference) = &draft.password_reference {
            tx.execute("INSERT INTO password_references(server_id, reference_json) VALUES(?1,?2) ON CONFLICT(server_id) DO UPDATE SET reference_json=excluded.reference_json", params![id, serde_json::to_string(reference).map_err(|e| e.to_string())?]).map_err(|e| e.to_string())?;
        } else {
            tx.execute("DELETE FROM password_references WHERE server_id=?1", [&id])
                .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        drop(connection);

        if updates_credentials {
            self.credentials.update_server(
                &id,
                is_new,
                draft.password.as_deref(),
                draft.key_passphrase.as_deref(),
                draft.sudo_password.as_deref(),
            )?;
        }
        let saved = self.get_server(&id)?;
        if updates_credentials
            || existing
                .as_ref()
                .is_some_and(|old| crate::ssh::profile_key(old) != crate::ssh::profile_key(&saved))
        {
            self.forget_session_password(&id);
        }
        Ok(saved)
    }

    fn validate_jump_host(
        &self,
        server_id: &str,
        jump_host_id: Option<&str>,
    ) -> Result<(), String> {
        let Some(mut current_id) = jump_host_id.map(str::to_string) else {
            return Ok(());
        };
        let mut visited = std::collections::HashSet::new();
        visited.insert(server_id.to_string());
        loop {
            if !visited.insert(current_id.clone()) {
                return Err("Bastion profiles cannot contain a connection cycle".to_string());
            }
            let profile = self
                .get_server(&current_id)
                .map_err(|_| "The selected bastion profile no longer exists".to_string())?;
            if profile.auth_method == AuthMethod::OpenSsh {
                return Err("Managed bastions cannot use OpenSSH-linked connections; configure ProxyJump in OpenSSH instead".into());
            }
            let Some(next) = profile.jump_host_id else {
                return Ok(());
            };
            current_id = next;
        }
    }

    pub fn rename_server(&self, id: &str, name: &str) -> Result<ServerProfile, String> {
        let name = required(name, "server name")?;
        let now = Utc::now().to_rfc3339();
        let connection = self
            .connection
            .lock()
            .map_err(|_| "ternway database lock was poisoned".to_string())?;
        let updated = connection
            .execute(
                "UPDATE servers SET name = ?1, updated_at = ?2 WHERE id = ?3",
                params![name, now, id],
            )
            .map_err(|error| format!("Could not rename server: {error}"))?;
        if updated == 0 {
            return Err("That server no longer exists".to_string());
        }
        drop(connection);
        self.get_server(id)
    }

    pub fn delete_server(&self, id: &str) -> Result<(), String> {
        self.credentials.remove_server(id)?;
        self.forget_session_password(id);
        let connection = self
            .connection
            .lock()
            .map_err(|_| "ternway database lock was poisoned".to_string())?;
        connection
            .execute("DELETE FROM servers WHERE id = ?1", [id])
            .map_err(|error| format!("Could not delete server: {error}"))?;
        Ok(())
    }

    pub fn duplicate_server(&self, id: &str) -> Result<ServerProfile, String> {
        let source = self.get_server(id)?;
        let draft = ServerDraft {
            id: None,
            name: format!("{} copy", source.name),
            host: source.host,
            username: source.username,
            port: source.port.into(),
            auth_method: source.auth_method.clone(),
            identity_id: source.identity_id,
            password_reference: source.password_reference.clone(),
            open_ssh: source.open_ssh,
            key_path: source.key_path,
            jump_host_id: source.jump_host_id,
            group_name: source.group_name,
            tags: source.tags,
            notes: source.notes,
            favorite: false,
            password: if source.auth_method == AuthMethod::OpenSsh
                || source.password_reference.is_some()
            {
                None
            } else {
                self.credentials.get(id, "password")?
            },
            key_passphrase: if source.auth_method == AuthMethod::OpenSsh {
                None
            } else {
                self.get_secret(id, "key-passphrase")?
            },
            sudo_password: if source.auth_method == AuthMethod::OpenSsh {
                None
            } else {
                self.get_secret(id, "sudo-password")?
            },
        };
        self.save_server(&draft)
    }

    pub fn mark_connected(&self, id: &str) -> Result<(), String> {
        let now = Utc::now().to_rfc3339();
        let connection = self
            .connection
            .lock()
            .map_err(|_| "ternway database lock was poisoned".to_string())?;
        connection
            .execute(
                "UPDATE servers SET last_connected_at = ?1 WHERE id = ?2",
                params![now, id],
            )
            .map_err(|error| format!("Could not update connection history: {error}"))?;
        Ok(())
    }

    pub fn list_saved_commands(
        &self,
        server_id: Option<&str>,
    ) -> Result<Vec<crate::models::SavedCommand>, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "ternway database lock was poisoned".to_string())?;
        let mut statement = connection.prepare(
            "SELECT id, server_id, name, command FROM saved_commands WHERE server_id IS NULL OR server_id = ?1 ORDER BY name COLLATE NOCASE"
        ).map_err(|error| format!("Could not read saved commands: {error}"))?;
        let rows = statement
            .query_map([server_id], |row| {
                Ok(crate::models::SavedCommand {
                    id: row.get(0)?,
                    server_id: row.get(1)?,
                    name: row.get(2)?,
                    command: row.get(3)?,
                })
            })
            .map_err(|error| format!("Could not read saved commands: {error}"))?;
        rows.map(|row| row.map_err(|error| format!("Could not decode saved command: {error}")))
            .collect()
    }

    pub fn save_saved_command(
        &self,
        input: &crate::models::SavedCommandInput,
    ) -> Result<crate::models::SavedCommand, String> {
        let name = required(&input.name, "command name")?;
        let command = required(&input.command, "command")?;
        if command.len() > 20_000 {
            return Err("Saved commands are limited to 20 KB".to_string());
        }
        if let Some(server_id) = input.server_id.as_deref() {
            self.get_server(server_id)?;
        }
        let id = input
            .id
            .clone()
            .filter(|id| !id.trim().is_empty())
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let connection = self
            .connection
            .lock()
            .map_err(|_| "ternway database lock was poisoned".to_string())?;
        connection.execute(
            "INSERT INTO saved_commands(id, server_id, name, command) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(id) DO UPDATE SET server_id=excluded.server_id, name=excluded.name, command=excluded.command",
            params![id, input.server_id, name, command],
        ).map_err(|error| format!("Could not save command: {error}"))?;
        Ok(crate::models::SavedCommand {
            id,
            server_id: input.server_id.clone(),
            name,
            command,
        })
    }

    pub fn delete_saved_command(&self, id: &str) -> Result<(), String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "ternway database lock was poisoned".to_string())?;
        connection
            .execute("DELETE FROM saved_commands WHERE id = ?1", [id])
            .map_err(|error| format!("Could not delete command: {error}"))?;
        Ok(())
    }

    pub fn list_tunnels(
        &self,
        server_id: &str,
    ) -> Result<Vec<crate::models::TunnelConfig>, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "ternway database lock was poisoned".to_string())?;
        let mut statement = connection.prepare("SELECT id, server_id, name, kind, bind_host, bind_port, target_host, target_port FROM tunnels WHERE server_id=?1 ORDER BY name COLLATE NOCASE")
            .map_err(|error| format!("Could not read tunnels: {error}"))?;
        let rows = statement
            .query_map([server_id], |row| {
                Ok(crate::models::TunnelConfig {
                    id: row.get(0)?,
                    server_id: row.get(1)?,
                    name: row.get(2)?,
                    kind: row.get(3)?,
                    bind_host: row.get(4)?,
                    bind_port: row.get(5)?,
                    target_host: row.get(6)?,
                    target_port: row.get(7)?,
                })
            })
            .map_err(|error| format!("Could not read tunnels: {error}"))?;
        rows.map(|row| row.map_err(|error| format!("Could not decode tunnel: {error}")))
            .collect()
    }

    pub fn get_tunnel(&self, id: &str) -> Result<crate::models::TunnelConfig, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "ternway database lock was poisoned".to_string())?;
        connection
            .query_row(
                "SELECT id, server_id, name, kind, bind_host, bind_port, target_host, target_port FROM tunnels WHERE id=?1",
                [id],
                |row| Ok(crate::models::TunnelConfig { id: row.get(0)?, server_id: row.get(1)?, name: row.get(2)?, kind: row.get(3)?, bind_host: row.get(4)?, bind_port: row.get(5)?, target_host: row.get(6)?, target_port: row.get(7)? }),
            )
            .optional()
            .map_err(|error| format!("Could not read tunnel: {error}"))?
            .ok_or_else(|| "That tunnel no longer exists".to_string())
    }

    pub fn save_tunnel(
        &self,
        input: &crate::models::TunnelInput,
    ) -> Result<crate::models::TunnelConfig, String> {
        self.get_server(&input.server_id)?;
        if !["local", "remote", "socks"].contains(&input.kind.as_str()) {
            return Err("Tunnel kind must be local, remote, or socks".to_string());
        }
        if !(1..=65535).contains(&input.bind_port) || !(1..=65535).contains(&input.target_port) {
            return Err("Tunnel ports must be between 1 and 65535".to_string());
        }
        let name = required(&input.name, "tunnel name")?;
        let bind_host = required(&input.bind_host, "bind host")?;
        let target_host = if input.kind == "socks" {
            input.target_host.trim().to_string()
        } else {
            required(&input.target_host, "target host")?
        };
        let id = input
            .id
            .clone()
            .filter(|id| !id.trim().is_empty())
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let tunnel = crate::models::TunnelConfig {
            id: id.clone(),
            server_id: input.server_id.clone(),
            name,
            kind: input.kind.clone(),
            bind_host,
            bind_port: input.bind_port as u16,
            target_host,
            target_port: input.target_port as u16,
        };
        let connection = self
            .connection
            .lock()
            .map_err(|_| "ternway database lock was poisoned".to_string())?;
        connection.execute("INSERT INTO tunnels(id,server_id,name,kind,bind_host,bind_port,target_host,target_port) VALUES(?1,?2,?3,?4,?5,?6,?7,?8) ON CONFLICT(id) DO UPDATE SET name=excluded.name,kind=excluded.kind,bind_host=excluded.bind_host,bind_port=excluded.bind_port,target_host=excluded.target_host,target_port=excluded.target_port", params![tunnel.id,tunnel.server_id,tunnel.name,tunnel.kind,tunnel.bind_host,tunnel.bind_port,tunnel.target_host,tunnel.target_port])
            .map_err(|error| format!("Could not save tunnel: {error}"))?;
        Ok(tunnel)
    }

    pub fn delete_tunnel(&self, id: &str) -> Result<(), String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "ternway database lock was poisoned".to_string())?;
        connection
            .execute("DELETE FROM tunnels WHERE id=?1", [id])
            .map_err(|error| format!("Could not delete tunnel: {error}"))?;
        Ok(())
    }
}

fn required(value: &str, label: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err(format!("Enter a {label}"));
    }
    Ok(value.to_string())
}

fn row_to_server(row: &rusqlite::Row<'_>) -> rusqlite::Result<ServerProfile> {
    let auth_method: String = row.get(5)?;
    let tags_json: String = row.get(8)?;
    Ok(ServerProfile {
        id: row.get(0)?,
        name: row.get(1)?,
        host: row.get(2)?,
        username: row.get(3)?,
        port: row.get(4)?,
        identity_id: row.get(15)?,
        password_reference: row
            .get::<_, Option<String>>(17)?
            .map(|value| {
                serde_json::from_str(&value).map_err(|e| {
                    rusqlite::Error::FromSqlConversionFailure(
                        17,
                        rusqlite::types::Type::Text,
                        Box::new(e),
                    )
                })
            })
            .transpose()?,
        open_ssh: row
            .get::<_, Option<String>>(16)?
            .map(|value| {
                serde_json::from_str(&value).map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(
                        16,
                        rusqlite::types::Type::Text,
                        Box::new(error),
                    )
                })
            })
            .transpose()?,
        auth_method: if auth_method == "openSsh" {
            AuthMethod::OpenSsh
        } else if auth_method == "sshAgent" {
            AuthMethod::SshAgent
        } else if auth_method == "privateKey" {
            AuthMethod::PrivateKey
        } else {
            AuthMethod::Password
        },
        key_path: row.get(6)?,
        group_name: row.get(7)?,
        tags: serde_json::from_str(&tags_json).unwrap_or_default(),
        jump_host_id: row.get(13)?,
        notes: row.get(14)?,
        favorite: row.get::<_, i64>(9)? != 0,
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
        last_connected_at: row.get(12)?,
    })
}

#[cfg(test)]
mod identity_migration_tests {
    use super::*;

    #[test]
    fn connection_group_changes_are_atomic_and_persist_without_vault_access() {
        let dir = std::env::temp_dir().join(format!("ternway-groups-{}", Uuid::new_v4()));
        let store = Store::open(&dir.join("state.sqlite"), &dir.join("vault")).unwrap();
        let draft: ServerDraft = serde_json::from_value(serde_json::json!({
            "name":"Lab", "host":"example.test", "username":"ubuntu", "port":239,
            "authMethod":"password", "groupName":"Original"
        }))
        .unwrap();
        let profile = store.save_server(&draft).unwrap();
        assert!(store
            .set_connection_group(&[profile.id.clone(), "missing".into()], "Other")
            .is_err());
        assert_eq!(
            store.get_server(&profile.id).unwrap().group_name.as_deref(),
            Some("Original")
        );
        store
            .set_connection_group(&[profile.id.clone()], " Lab ")
            .unwrap();
        drop(store);
        let store = Store::open(&dir.join("state.sqlite"), &dir.join("vault")).unwrap();
        assert_eq!(
            store.get_server(&profile.id).unwrap().group_name.as_deref(),
            Some("Lab")
        );
        store
            .set_connection_group(&[profile.id.clone()], "")
            .unwrap();
        assert!(store.get_server(&profile.id).unwrap().group_name.is_none());
        assert!(!dir.join("vault").exists());
        drop(store);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn system_agent_identity_persists_a_selector_without_resolving_the_environment() {
        let dir = std::env::temp_dir().join(format!("tw-system-agent-{}", Uuid::new_v4()));
        let store = Store::open(&dir.join("state.sqlite"), &dir.join("vault")).unwrap();
        let identity = crate::identities::Identity {
            id: "system".into(),
            name: "System SSH agent".into(),
            username: "alice".into(),
            provider: crate::identities::IdentityProvider::SshAgent,
            reference: crate::identities::SYSTEM_AGENT_REFERENCE.into(),
        };
        store.create_identity(&identity).unwrap();
        assert_eq!(store.resolve_identity("system").unwrap(), identity);
        assert!(!dir.join("vault").exists());
        drop(store);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn agent_identity_resolution_and_assignment_are_validated_without_unlocking_vault() {
        let dir = std::env::temp_dir().join(format!("ternway-agent-{}", Uuid::new_v4()));
        let store = Store::open(&dir.join("state.sqlite"), &dir.join("vault")).unwrap();
        let identity = crate::identities::Identity {
            id: "work".into(),
            name: "Work".into(),
            username: "alice".into(),
            provider: crate::identities::IdentityProvider::SshAgent,
            reference: "/tmp/agent.sock".into(),
        };
        store.create_identity(&identity).unwrap();
        assert!(store.create_identity(&identity).is_err());
        let mut draft: ServerDraft = serde_json::from_value(serde_json::json!({
            "name":"Host", "host":"example.test", "username":"ignored", "port":22,
            "authMethod":"sshAgent", "identityId":"missing"
        }))
        .unwrap();
        assert!(store.save_server(&draft).is_err());
        assert!(store.list_servers().unwrap().is_empty());
        draft.identity_id = Some("work".into());
        let first = store.save_server(&draft).unwrap();
        let second = store.save_server(&draft).unwrap();
        assert_eq!(first.username, "alice");
        assert_eq!(first.auth_method, AuthMethod::SshAgent);
        assert_eq!(
            store.get_server(&first.id).unwrap().identity_id.as_deref(),
            Some("work")
        );
        assert!(store.delete_identity("work").is_err());
        assert_eq!(store.resolve_identity("work").unwrap(), identity);
        assert!(store.resolve_identity("missing").is_err());
        draft.id = Some(first.id.clone());
        draft.auth_method = AuthMethod::Password;
        draft.identity_id = None;
        store.save_server(&draft).unwrap();
        assert!(store.get_server(&first.id).unwrap().identity_id.is_none());
        assert_eq!(
            store.get_server(&second.id).unwrap().identity_id.as_deref(),
            Some("work")
        );
        assert!(!dir.join("vault").exists());
        drop(store);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn opening_and_reopening_store_preserves_vault_bytes() {
        let directory = std::env::temp_dir().join(format!("ternway-store-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let database = directory.join("state.sqlite");
        let vault = directory.join("credentials.bin");
        let existing = b"existing encrypted vault is not read during schema migration";
        std::fs::write(&vault, existing).unwrap();
        for _ in 0..2 {
            let store = Store::open(&database, &vault).unwrap();
            assert!(store.list_servers().unwrap().is_empty());
            assert_eq!(std::fs::read(&vault).unwrap(), existing);
        }
        assert!(database.with_extension("pre-identities.sqlite").exists());
        std::fs::remove_dir_all(directory).unwrap();
    }
}

#[cfg(test)]
mod password_storage_tests {
    use super::*;

    #[test]
    fn transient_passwords_are_shared_in_memory_and_never_persisted_or_duplicated() {
        let dir = std::env::temp_dir().join(format!("ternway-password-store-{}", Uuid::new_v4()));
        let store = Store::open(&dir.join("db"), &dir.join("vault")).unwrap();
        let draft: ServerDraft = serde_json::from_value(serde_json::json!({"name":"qa", "host":"127.0.0.1", "username":"qa", "port":22, "authMethod":"password"})).unwrap();
        let profile = store.save_server(&draft).unwrap();
        store
            .set_ssh_password(&profile.id, " secret with spaces ", false)
            .unwrap();
        assert_eq!(
            store
                .clone()
                .get_secret(&profile.id, "password")
                .unwrap()
                .as_deref(),
            Some(" secret with spaces ")
        );
        let copy = store.duplicate_server(&profile.id).unwrap();
        assert_eq!(store.get_secret(&copy.id, "password").unwrap(), None);
        assert!(!dir.join("vault").exists());
        let reopened = Store::open(&dir.join("db"), &dir.join("vault")).unwrap();
        assert_eq!(reopened.get_secret(&profile.id, "password").unwrap(), None);
        store.forget_session_password(&profile.id);
        assert_eq!(store.get_secret(&profile.id, "password").unwrap(), None);
        drop(store);
        drop(reopened);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn remembering_requires_vault_unlock_and_survives_reopening() {
        let dir = std::env::temp_dir().join(format!("ternway-remember-{}", Uuid::new_v4()));
        let store = Store::open(&dir.join("db"), &dir.join("vault")).unwrap();
        let draft: ServerDraft = serde_json::from_value(serde_json::json!({"name":"qa", "host":"127.0.0.1", "username":"qa", "port":22, "authMethod":"password"})).unwrap();
        let profile = store.save_server(&draft).unwrap();
        assert!(store
            .set_ssh_password(&profile.id, "ssh fixture password", true)
            .unwrap_err()
            .starts_with("MASTER_PASSWORD_SETUP_REQUIRED:"));
        assert_eq!(store.get_secret(&profile.id, "password").unwrap(), None);
        store.unlock_credentials("fixture vault password").unwrap();
        store
            .set_ssh_password(&profile.id, "ssh fixture password", true)
            .unwrap();
        drop(store);
        let reopened = Store::open(&dir.join("db"), &dir.join("vault")).unwrap();
        assert!(reopened.get_secret(&profile.id, "password").is_err());
        reopened
            .unlock_credentials("fixture vault password")
            .unwrap();
        assert_eq!(
            reopened
                .get_secret(&profile.id, "password")
                .unwrap()
                .as_deref(),
            Some("ssh fixture password")
        );
        drop(reopened);
        std::fs::remove_dir_all(dir).unwrap();
    }
}

#[cfg(test)]
mod credential_privacy_tests {
    use super::*;
    #[test]
    fn external_references_survive_save_duplicate_and_reopen_without_secret_reads() {
        let dir = std::env::temp_dir().join(format!("ternway-provider-{}", Uuid::new_v4()));
        let store = Store::open(&dir.join("db"), &dir.join("vault")).unwrap();
        let mut draft: ServerDraft = serde_json::from_value(serde_json::json!({"name":"qa", "host":"127.0.0.1", "username":"qa", "port":22, "authMethod":"password", "passwordReference":{"provider":"onePassword", "reference":"op://Work/QA/password"}})).unwrap();
        let saved = store.save_server(&draft).unwrap();
        assert_eq!(saved.password_reference, draft.password_reference);
        assert_eq!(
            store
                .duplicate_server(&saved.id)
                .unwrap()
                .password_reference,
            draft.password_reference
        );
        let reopened = Store::open(&dir.join("db"), &dir.join("vault")).unwrap();
        assert_eq!(
            reopened.get_server(&saved.id).unwrap().password_reference,
            draft.password_reference
        );
        assert!(!dir.join("vault").exists());
        draft.auth_method = AuthMethod::OpenSsh;
        assert!(store.save_server(&draft).is_err());
        let _ = std::fs::remove_dir_all(dir);
    }
    #[test]
    fn lock_clears_saved_and_transient_credentials_across_store_clones() {
        let dir = std::env::temp_dir().join(format!("ternway-lock-{}", Uuid::new_v4()));
        let store = Store::open(&dir.join("db"), &dir.join("vault")).unwrap();
        let draft: ServerDraft = serde_json::from_value(
            serde_json::json!({"name":"qa", "host":"127.0.0.1", "username":"qa", "port":22}),
        )
        .unwrap();
        let server = store.save_server(&draft).unwrap();
        store.unlock_credentials("fixture vault password").unwrap();
        store
            .set_ssh_password(&server.id, "saved secret", true)
            .unwrap();
        let bytes = std::fs::read(dir.join("vault")).unwrap();
        let clone = store.clone();
        clone.lock_credentials();
        assert!(!store.credential_status().unlocked);
        assert!(store.get_secret(&server.id, "password").is_err());
        assert_eq!(std::fs::read(dir.join("vault")).unwrap(), bytes);
        store.unlock_credentials("fixture vault password").unwrap();
        assert_eq!(
            store.get_secret(&server.id, "password").unwrap().unwrap(),
            "saved secret"
        );
        let _ = std::fs::remove_dir_all(dir);
    }
}
