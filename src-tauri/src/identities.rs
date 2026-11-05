//! Secret-free identity metadata. Legacy vault entries stay keyed by server ID
//! until the explicit credential migration is implemented.
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum IdentityProvider {
    LocalVault,
    SshAgent,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    pub id: String,
    pub name: String,
    pub username: String,
    pub provider: IdentityProvider,
    /// A vault reference or agent socket path; never a password or private key.
    pub reference: String,
}

/// Back up the existing database before the first identity migration. SQLite's
/// VACUUM INTO includes committed WAL data, unlike copying the database file.
pub fn migrate(connection: &mut Connection, database_path: &Path) -> Result<(), String> {
    let version: i64 = connection
        .query_row("SELECT version FROM schema_version", [], |row| row.get(0))
        .map_err(|e| format!("Could not read schema version: {e}"))?;
    if version > 2 {
        return Err("This database was created by a newer version of the app".into());
    }
    if version == 2 {
        return Ok(());
    }
    if version != 1 {
        return Err(format!("Unsupported database version: {version}"));
    }
    let backup = database_path.with_extension("pre-identities.sqlite");
    if !backup.exists() {
        connection
            .execute("VACUUM INTO ?1", [backup.to_string_lossy().as_ref()])
            .map_err(|e| format!("Could not back up database before identity migration: {e}"))?;
    }
    let tx = connection.transaction().map_err(|e| e.to_string())?;
    tx.execute_batch(
        "CREATE TABLE identities (
            id TEXT PRIMARY KEY NOT NULL,
            name TEXT NOT NULL CHECK(length(trim(name)) > 0),
            username TEXT NOT NULL CHECK(length(trim(username)) > 0),
            provider TEXT NOT NULL CHECK(provider IN ('localVault', 'sshAgent')),
            reference TEXT NOT NULL CHECK(length(trim(reference)) > 0)
        );
        CREATE TABLE connection_identities (
            server_id TEXT PRIMARY KEY NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
            identity_id TEXT NOT NULL REFERENCES identities(id) ON DELETE RESTRICT
        );
        CREATE INDEX connection_identity_lookup ON connection_identities(identity_id);
        UPDATE schema_version SET version = 2;",
    )
    .map_err(|e| format!("Could not migrate identity storage: {e}"))?;
    tx.commit()
        .map_err(|e| format!("Could not commit identity migration: {e}"))
}

pub fn save(connection: &Connection, identity: &Identity) -> Result<(), String> {
    if [
        &identity.id,
        &identity.name,
        &identity.username,
        &identity.reference,
    ]
    .iter()
    .any(|v| v.trim().is_empty())
    {
        return Err("Identity ID, name, username and provider reference are required".into());
    }
    let provider = match identity.provider {
        IdentityProvider::LocalVault => "localVault",
        IdentityProvider::SshAgent => "sshAgent",
    };
    connection.execute(
        "INSERT INTO identities(id,name,username,provider,reference) VALUES (?1,?2,?3,?4,?5)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name,username=excluded.username,provider=excluded.provider,reference=excluded.reference",
        params![identity.id, identity.name.trim(), identity.username.trim(), provider, identity.reference],
    ).map_err(|e| format!("Could not save identity: {e}"))?;
    Ok(())
}

pub fn list(connection: &Connection) -> Result<Vec<Identity>, String> {
    let mut statement = connection.prepare("SELECT id,name,username,provider,reference FROM identities ORDER BY name COLLATE NOCASE,id")
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([], |row| {
            let provider: String = row.get(3)?;
            let provider = match provider.as_str() {
                "localVault" => IdentityProvider::LocalVault,
                "sshAgent" => IdentityProvider::SshAgent,
                _ => return Err(rusqlite::Error::InvalidQuery),
            };
            Ok(Identity {
                id: row.get(0)?,
                name: row.get(1)?,
                username: row.get(2)?,
                provider,
                reference: row.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

pub fn assign(
    connection: &Connection,
    server_id: &str,
    identity_id: Option<&str>,
) -> Result<(), String> {
    if let Some(id) = identity_id {
        connection.execute("INSERT INTO connection_identities(server_id,identity_id) VALUES (?1,?2) ON CONFLICT(server_id) DO UPDATE SET identity_id=excluded.identity_id", params![server_id, id])
            .map_err(|e| format!("Could not assign identity: {e}"))?;
    } else {
        connection
            .execute(
                "DELETE FROM connection_identities WHERE server_id=?1",
                [server_id],
            )
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn assigned(connection: &Connection, server_id: &str) -> Result<Option<String>, String> {
    connection
        .query_row(
            "SELECT identity_id FROM connection_identities WHERE server_id=?1",
            [server_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())
}

pub fn delete(connection: &Connection, id: &str) -> Result<(), String> {
    connection
        .execute("DELETE FROM identities WHERE id=?1", [id])
        .map_err(|_| {
            "Could not delete identity; remove its connection references first".to_string()
        })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (Connection, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("hbox-identities-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("state.sqlite");
        let connection = Connection::open(&path).unwrap();
        connection.execute_batch("PRAGMA foreign_keys=ON; CREATE TABLE schema_version(version INTEGER NOT NULL); INSERT INTO schema_version VALUES(1); CREATE TABLE servers(id TEXT PRIMARY KEY, name TEXT); INSERT INTO servers VALUES('a','Existing host'),('b','Other host');").unwrap();
        (connection, path)
    }
    fn identity() -> Identity {
        Identity {
            id: "work".into(),
            name: "Work".into(),
            username: "alice".into(),
            provider: IdentityProvider::SshAgent,
            reference: "/home/alice/.ssh/agent.sock".into(),
        }
    }
    #[test]
    fn migration_preserves_profiles_and_creates_recoverable_backup() {
        let (mut db, path) = fixture();
        migrate(&mut db, &path).unwrap();
        migrate(&mut db, &path).unwrap();
        assert_eq!(
            db.query_row("SELECT name FROM servers WHERE id='a'", [], |r| r
                .get::<_, String>(0))
                .unwrap(),
            "Existing host"
        );
        let backup = Connection::open(path.with_extension("pre-identities.sqlite")).unwrap();
        assert_eq!(
            backup
                .query_row("SELECT version FROM schema_version", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert!(list(&db).unwrap().is_empty());
        assert_eq!(assigned(&db, "a").unwrap(), None);
        drop(backup);
        drop(db);
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }
    #[test]
    fn identities_are_reusable_and_referenced_deletion_is_rejected() {
        let (mut db, path) = fixture();
        migrate(&mut db, &path).unwrap();
        let mut item = identity();
        save(&db, &item).unwrap();
        for server in ["a", "b"] {
            assign(&db, server, Some("work")).unwrap();
        }
        assert!(delete(&db, "work").is_err());
        assert!(assign(&db, "a", Some("missing")).is_err());
        assert_eq!(assigned(&db, "a").unwrap(), Some("work".into()));
        item.username = "bob".into();
        save(&db, &item).unwrap();
        assert_eq!(list(&db).unwrap(), vec![item]);
        db.execute("DELETE FROM servers WHERE id='a'", []).unwrap();
        assert_eq!(assigned(&db, "a").unwrap(), None);
        assert!(delete(&db, "work").is_err());
        assign(&db, "b", None).unwrap();
        delete(&db, "work").unwrap();
        assert!(list(&db).unwrap().is_empty());
        drop(db);
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }
    #[test]
    fn failed_migration_rolls_back_and_future_versions_are_rejected() {
        let (mut db, path) = fixture();
        db.execute("CREATE TABLE connection_identities(conflict TEXT)", [])
            .unwrap();
        assert!(migrate(&mut db, &path).is_err());
        assert_eq!(
            db.query_row("SELECT version FROM schema_version", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert!(list(&db).is_err());
        db.execute("UPDATE schema_version SET version=3", [])
            .unwrap();
        assert!(migrate(&mut db, &path)
            .unwrap_err()
            .contains("newer version"));
        drop(db);
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }
    #[test]
    fn empty_identity_fields_are_rejected() {
        let (mut db, path) = fixture();
        migrate(&mut db, &path).unwrap();
        let mut item = identity();
        item.reference = " ".into();
        assert!(save(&db, &item).is_err());
        assert!(list(&db).unwrap().is_empty());
        drop(db);
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }
}

pub fn agent_socket(reference: &str) -> Result<std::path::PathBuf, String> {
    if reference.contains('\0') {
        return Err("Agent socket path contains an invalid character".into());
    }
    let path = if let Some(rest) = reference.strip_prefix("~/") {
        dirs::home_dir()
            .ok_or("Could not find your home directory")?
            .join(rest)
    } else {
        std::path::PathBuf::from(reference)
    };
    if !path.is_absolute() {
        return Err("Enter an absolute SSH agent socket path (or a path starting with ~/)".into());
    }
    Ok(path)
}

#[cfg(test)]
mod agent_tests {
    use super::*;
    #[test]
    fn sockets_accept_native_absolute_paths_and_reject_relative_or_nul_paths() {
        for path in [
            "/Users/alice/Library/agent.sock",
            "/run/user/1000/agent.sock",
        ] {
            assert_eq!(agent_socket(path).unwrap(), std::path::PathBuf::from(path));
        }
        for path in ["", "relative/socket", "socket\0path"] {
            assert!(agent_socket(path).is_err());
        }
        assert!(agent_socket("~/.ssh/agent.sock").unwrap().is_absolute());
    }
    #[test]
    fn unavailable_agent_fails_without_changing_process_environment() {
        let before = std::env::var_os("SSH_AUTH_SOCK");
        let missing = std::env::temp_dir().join(format!("missing-agent-{}", uuid::Uuid::new_v4()));
        let error = probe_agent(missing.to_str().unwrap()).unwrap_err();
        assert!(error.contains("Could not reach SSH agent"));
        assert_eq!(std::env::var_os("SSH_AUTH_SOCK"), before);
    }
}

/// Shared by authentication and the explicit UI availability check.
pub fn connect_agent(session: &ssh2::Session, reference: &str) -> Result<ssh2::Agent, String> {
    #[cfg(unix)]
    crate::agent_transport::install(session);
    let socket = agent_socket(reference)?;
    let mut agent = session
        .agent()
        .map_err(|e| format!("Could not initialize SSH agent: {e}"))?;
    agent
        .set_identity_path(&socket)
        .map_err(|e| format!("Invalid SSH agent socket: {e}"))?;
    agent.connect().map_err(|e| format!("Could not reach SSH agent at {}. Start or unlock your password manager and check its agent socket: {e}", socket.display()))?;
    agent
        .list_identities()
        .map_err(|e| format!("Could not list agent keys. Unlock your password manager: {e}"))?;
    Ok(agent)
}

pub fn probe_agent(reference: &str) -> Result<usize, String> {
    let session = ssh2::Session::new().map_err(|e| e.to_string())?;
    let mut agent = connect_agent(&session, reference)?;
    let count = agent
        .identities()
        .map_err(|e| format!("Could not read agent keys: {e}"))?
        .len();
    let _ = agent.disconnect();
    Ok(count)
}

pub fn find_onepassword_agent() -> Result<String, String> {
    let home = dirs::home_dir().ok_or("Could not find your home directory")?;
    let candidates = [
        home.join(".1password/agent.sock"),
        home.join("Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock"),
    ];
    #[cfg(unix)]
    {
        use std::os::unix::fs::FileTypeExt;
        for path in candidates {
            if std::fs::metadata(&path).is_ok_and(|m| m.file_type().is_socket()) {
                return Ok(path.to_string_lossy().into_owned());
            }
        }
    }
    Err("1Password's agent socket was not found. Enable its SSH agent, or enter a custom socket path.".into())
}

#[cfg(test)]
mod live_agent_tests {
    #[test]
    #[ignore = "Requires a running 1Password agent and explicit user authorization"]
    fn onepassword_agent_exposes_keys_through_application_client() {
        let path = super::find_onepassword_agent().expect("1Password socket exists");
        let count = super::probe_agent(&path).expect("application's libssh2 client reaches agent");
        assert!(
            count > 0,
            "agent must expose at least one key for live verification"
        );
        println!("Application agent client successfully enumerated {count} public keys");
    }
}
