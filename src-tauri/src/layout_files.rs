//! Private, versioned workspace layouts. Files never contain executable session requests.
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{Read, Write},
    os::unix::fs::{DirBuilderExt, OpenOptionsExt},
    path::{Path, PathBuf},
};
const MAX_LAYOUT_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceFile {
    pub version: u32,
    pub id: String,
    pub name: String,
    pub layout: serde_json::Value,
}
#[derive(Serialize)]
pub(crate) struct WorkspaceList {
    pub entries: Vec<WorkspaceFile>,
    pub skipped: Vec<String>,
}

pub(crate) fn identifier(id: &str) -> Result<String, String> {
    uuid::Uuid::parse_str(id)
        .map(|id| id.to_string())
        .map_err(|_| "Invalid workspace identifier".into())
}
pub(crate) fn private_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if bytes.len() as u64 > MAX_LAYOUT_BYTES {
        return Err("Layout exceeds 16 MiB".into());
    }
    let directory = path.parent().ok_or("Layout directory unavailable")?;
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(directory)
        .map_err(|e| e.to_string())?;
    let temporary = directory.join(format!(".{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temporary)
            .map_err(|e| e.to_string())?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|e| e.to_string())?;
        fs::rename(&temporary, path).map_err(|e| e.to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}
pub(crate) fn read(path: &Path) -> Result<String, String> {
    let file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut contents = String::new();
    file.take(MAX_LAYOUT_BYTES + 1)
        .read_to_string(&mut contents)
        .map_err(|e| e.to_string())?;
    if contents.len() as u64 > MAX_LAYOUT_BYTES {
        return Err("Layout exceeds 16 MiB".into());
    }
    Ok(contents)
}
fn path(directory: &Path, id: &str) -> Result<PathBuf, String> {
    Ok(directory.join(format!("{}.json", identifier(id)?)))
}
pub(crate) fn load(directory: &Path, id: &str) -> Result<WorkspaceFile, String> {
    let id = identifier(id)?;
    let workspace: WorkspaceFile = serde_json::from_str(&read(&path(directory, &id)?)?)
        .map_err(|_| "Invalid workspace file")?;
    if workspace.version != 1 || workspace.id != id {
        return Err("Unsupported workspace file".into());
    }
    Ok(workspace)
}
pub(crate) fn list(directory: &Path) -> Result<WorkspaceList, String> {
    let mut result = WorkspaceList {
        entries: vec![],
        skipped: vec![],
    };
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(result),
        Err(e) => return Err(e.to_string()),
    };
    let mut total_bytes = 0u64;
    for (index, entry) in entries.enumerate() {
        if index >= 1024 {
            return Err("Workspace library has too many files".into());
        }
        let entry = entry.map_err(|e| e.to_string())?;
        let p = entry.path();
        if p.extension().is_none_or(|e| e != "json") {
            continue;
        }
        if !entry.file_type().map_err(|e| e.to_string())?.is_file() {
            continue;
        }
        total_bytes =
            total_bytes.saturating_add(entry.metadata().map_err(|e| e.to_string())?.len());
        if total_bytes > 64 * 1024 * 1024 {
            return Err("Workspace library exceeds 64 MiB; archive older layouts".into());
        }
        let id = p
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned();
        match load(directory, &id) {
            Ok(workspace) => result.entries.push(workspace),
            Err(_) => result.skipped.push(id),
        }
    }
    result
        .entries
        .sort_by_key(|entry| entry.name.to_lowercase());
    Ok(result)
}
pub(crate) fn save(
    directory: &Path,
    id: Option<&str>,
    name: &str,
    layout: serde_json::Value,
) -> Result<WorkspaceFile, String> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 80 || name.chars().any(char::is_control) {
        return Err("Use a workspace name of 1–80 characters".into());
    }
    if !matches!(layout.get("version").and_then(|v| v.as_u64()), Some(1 | 2))
        || !layout.get("groups").is_some_and(|v| v.is_array())
    {
        return Err("Invalid workspace layout".into());
    }
    let id = match id {
        Some(id) => identifier(id)?,
        None => uuid::Uuid::new_v4().to_string(),
    };
    if list(directory)?
        .entries
        .iter()
        .any(|entry| entry.id != id && entry.name.to_lowercase() == name.to_lowercase())
    {
        return Err("A workspace with that name already exists".into());
    }
    let workspace = WorkspaceFile {
        version: 1,
        id,
        name: name.into(),
        layout,
    };
    private_write(
        &path(directory, &workspace.id)?,
        &serde_json::to_vec(&workspace).map_err(|e| e.to_string())?,
    )?;
    Ok(workspace)
}
pub(crate) fn remove(directory: &Path, id: &str) -> Result<(), String> {
    fs::remove_file(path(directory, id)?).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    #[test]
    fn layouts_round_trip_privately_without_path_escape_or_silent_overwrite() {
        let directory =
            std::env::temp_dir().join(format!("ternway-layout-{}", uuid::Uuid::new_v4()));
        let layout = serde_json::json!({"version":2,"groups":[]});
        let saved = save(&directory, None, " Work ", layout.clone()).unwrap();
        assert_eq!(load(&directory, &saved.id).unwrap().name, "Work");
        assert_eq!(
            fs::metadata(path(&directory, &saved.id).unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        assert!(save(&directory, None, "work", layout.clone()).is_err());
        assert!(save(&directory, Some("../../outside"), "Other", layout.clone()).is_err());
        assert!(save(&directory, Some(&saved.id), "", layout.clone()).is_err());
        assert_eq!(load(&directory, &saved.id).unwrap().name, "Work");
        save(&directory, Some(&saved.id), "Renamed", layout).unwrap();
        let corrupt = uuid::Uuid::new_v4().to_string();
        fs::write(path(&directory, &corrupt).unwrap(), b"broken").unwrap();
        let listed = list(&directory).unwrap();
        assert_eq!(listed.entries.len(), 1);
        assert_eq!(listed.skipped, vec![corrupt]);
        let before = fs::read(path(&directory, &saved.id).unwrap()).unwrap();
        assert!(private_write(
            &path(&directory, &saved.id).unwrap(),
            &vec![b'x'; MAX_LAYOUT_BYTES as usize + 1]
        )
        .is_err());
        assert_eq!(
            fs::read(path(&directory, &saved.id).unwrap()).unwrap(),
            before
        );
        remove(&directory, &saved.id).unwrap();
        assert!(load(&directory, &saved.id).is_err());
        let _ = fs::remove_dir_all(directory);
    }
}
