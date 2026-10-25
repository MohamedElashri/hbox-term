//! The hbox-term config file, in Ghostty's `key = value` format.
//!
//! Rust reads the files, follows `config-file` includes, finds theme files and watches
//! everything it read; the frontend interprets the keys. A new config includes the user's
//! Ghostty config, so Ghostty settings apply without copying them.

use notify::event::ModifyKind;
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

const MAX_INCLUDE_DEPTH: usize = 10;
const RELOAD_DEBOUNCE: Duration = Duration::from_millis(150);

const DEFAULT_CONFIG_HEADER: &str = "\
# hbox-term configuration, in Ghostty's format: https://ghostty.org/docs/config
#
# Your Ghostty config is included below, so what you set there applies here too.
# Settings after the include override it for hbox-term only. Changes apply on save.
";

/// The new config: a header plus optional includes of the Ghostty configs Ghostty itself reads.
fn default_config() -> String {
    let mut text = DEFAULT_CONFIG_HEADER.to_string();
    let home = dirs::home_dir();
    let display = |path: PathBuf| match home.as_ref().and_then(|home| path.strip_prefix(home).ok())
    {
        Some(relative) => format!("~/{}", relative.display()),
        None => path.display().to_string(),
    };
    if let Some(config_home) = config_home() {
        text.push_str(&format!(
            "config-file = ?{}\n",
            display(config_home.join("ghostty").join("config"))
        ));
    }
    if cfg!(target_os = "macos") {
        if let Some(home) = &home {
            let path = home.join("Library/Application Support/com.mitchellh.ghostty/config");
            text.push_str(&format!("config-file = ?{}\n", display(path)));
        }
    }
    text
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigEntry {
    pub file: String,
    pub line: usize,
    pub key: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedConfig {
    pub path: String,
    pub entries: Vec<ConfigEntry>,
    pub errors: Vec<String>,
    /// Files in `profiles/`; each is layered on top of the main config.
    pub profiles: Vec<ProfileConfig>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileConfig {
    pub name: String,
    pub entries: Vec<ConfigEntry>,
}

/// Keeps the file watcher alive; replaced on every load because includes can change.
#[derive(Default)]
pub struct ConfigWatcher(Mutex<Option<RecommendedWatcher>>);

/// `$XDG_CONFIG_HOME` or `~/.config`, on macOS too, like Ghostty.
fn config_home() -> Option<PathBuf> {
    std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .or_else(|| dirs::home_dir().map(|home| home.join(".config")))
}

pub fn config_path() -> Result<PathBuf, String> {
    config_home()
        .map(|home| home.join("hbox-term").join("config"))
        .ok_or_else(|| "Could not find your home directory".to_string())
}

fn expand_home(value: &str) -> PathBuf {
    match (value.strip_prefix("~/"), dirs::home_dir()) {
        (Some(rest), Some(home)) => home.join(rest),
        _ => PathBuf::from(value),
    }
}

/// Splits a `key = value` line. Comments and blank lines give `None`.
fn parse_line(line: &str) -> Option<(String, String)> {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') {
        return None;
    }
    let (key, value) = line.split_once('=').unwrap_or((line, ""));
    let value = value.trim();
    let value = value
        .strip_prefix('"')
        .and_then(|inner| inner.strip_suffix('"'))
        .unwrap_or(value);
    Some((key.trim().to_string(), value.to_string()))
}

fn read_entries(
    path: &Path,
    depth: usize,
    visited: &mut HashSet<PathBuf>,
    loaded: &mut LoadedConfig,
    files: &mut Vec<PathBuf>,
) {
    let canonical = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    if !visited.insert(canonical) {
        loaded
            .errors
            .push(format!("{} is included more than once", path.display()));
        return;
    }
    files.push(path.to_path_buf());
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) => {
            loaded
                .errors
                .push(format!("Could not read {}: {error}", path.display()));
            return;
        }
    };
    for (index, line) in text.lines().enumerate() {
        let Some((key, value)) = parse_line(line) else {
            continue;
        };
        if key == "config-file" {
            let (optional, target) = match value.strip_prefix('?') {
                Some(target) => (true, target),
                None => (false, value.as_str()),
            };
            let target = expand_home(target);
            let target = if target.is_absolute() {
                target
            } else {
                path.parent().unwrap_or(Path::new("/")).join(target)
            };
            if depth >= MAX_INCLUDE_DEPTH {
                loaded
                    .errors
                    .push(format!("Includes nest too deeply at {}", target.display()));
            } else if target.exists() {
                read_entries(&target, depth + 1, visited, loaded, files);
            } else if !optional {
                loaded
                    .errors
                    .push(format!("Included file {} does not exist", target.display()));
            } else {
                // Watch optional includes too, so creating one later applies it.
                files.push(target);
            }
            continue;
        }
        loaded.entries.push(ConfigEntry {
            file: path.display().to_string(),
            line: index + 1,
            key,
            value,
        });
    }
}

/// Loads the config (creating the default one first) and watches every file it read.
pub fn load(app: &AppHandle, watcher: &ConfigWatcher) -> Result<LoadedConfig, String> {
    let path = config_path()?;
    if !path.exists() {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("Could not create {}: {error}", parent.display()))?;
        }
        fs::write(&path, default_config())
            .map_err(|error| format!("Could not create {}: {error}", path.display()))?;
    }
    let mut loaded = LoadedConfig {
        path: path.display().to_string(),
        entries: Vec::new(),
        errors: Vec::new(),
        profiles: Vec::new(),
    };
    let mut files = Vec::new();
    read_entries(&path, 0, &mut HashSet::new(), &mut loaded, &mut files);
    let profiles_dir = path.with_file_name("profiles");
    loaded.profiles = read_profiles(&profiles_dir, &mut loaded.errors, &mut files);
    if let Err(error) = watch(app, watcher, &files, &profiles_dir) {
        loaded.errors.push(error);
    }
    Ok(loaded)
}

fn read_profiles(
    dir: &Path,
    errors: &mut Vec<String>,
    files: &mut Vec<PathBuf>,
) -> Vec<ProfileConfig> {
    let Ok(listing) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut paths: Vec<PathBuf> = listing
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|path| path.is_file())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| !name.starts_with('.') && !name.ends_with('~'))
        })
        .collect();
    paths.sort();
    paths
        .into_iter()
        .map(|path| {
            let mut profile = LoadedConfig {
                path: path.display().to_string(),
                entries: Vec::new(),
                errors: Vec::new(),
                profiles: Vec::new(),
            };
            read_entries(&path, 0, &mut HashSet::new(), &mut profile, files);
            errors.append(&mut profile.errors);
            ProfileConfig {
                name: path
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned(),
                entries: profile.entries,
            }
        })
        .collect()
}

/// Theme lookup order matches Ghostty: user theme directories, then the bundled themes.
fn theme_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(home) = config_home() {
        dirs.push(home.join("hbox-term").join("themes"));
        dirs.push(home.join("ghostty").join("themes"));
    }
    if let Some(resources) = std::env::var_os("GHOSTTY_RESOURCES_DIR") {
        dirs.push(PathBuf::from(resources).join("themes"));
    }
    dirs.push(PathBuf::from("/usr/share/ghostty/themes"));
    dirs.push(PathBuf::from("/usr/local/share/ghostty/themes"));
    dirs.push(PathBuf::from(
        "/Applications/Ghostty.app/Contents/Resources/ghostty/themes",
    ));
    dirs
}

/// Reads a theme by name, or by absolute path as Ghostty allows.
pub fn load_theme(name: &str) -> Result<Vec<ConfigEntry>, String> {
    let name = name.trim();
    let path = if name.starts_with('/') || name.starts_with("~/") {
        expand_home(name)
    } else {
        if name.is_empty() || name.contains('/') || name.contains("..") {
            return Err(format!("Invalid theme name \"{name}\""));
        }
        theme_dirs()
            .into_iter()
            .map(|dir| dir.join(name))
            .find(|path| path.is_file())
            .ok_or_else(|| format!("Theme \"{name}\" was not found"))?
    };
    let text = fs::read_to_string(&path)
        .map_err(|error| format!("Could not read theme {}: {error}", path.display()))?;
    Ok(text
        .lines()
        .enumerate()
        .filter_map(|(index, line)| {
            parse_line(line).map(|(key, value)| ConfigEntry {
                file: path.display().to_string(),
                line: index + 1,
                key,
                value,
            })
        })
        .collect())
}

fn watch(
    app: &AppHandle,
    watcher: &ConfigWatcher,
    files: &[PathBuf],
    profiles_dir: &Path,
) -> Result<(), String> {
    let watched: HashSet<PathBuf> = files.iter().cloned().collect();
    let profiles = profiles_dir.to_path_buf();
    let (sender, receiver) = mpsc::channel::<()>();
    let mut new_watcher =
        notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
            if let Ok(event) = event {
                // Reading the config produces access events; only react to real changes.
                let changed = matches!(
                    event.kind,
                    EventKind::Create(_)
                        | EventKind::Remove(_)
                        | EventKind::Modify(
                            ModifyKind::Data(_) | ModifyKind::Name(_) | ModifyKind::Any
                        )
                );
                // Any file in profiles/ counts, so new profiles are picked up.
                let relevant = event.paths.iter().any(|path| {
                    watched.contains(path) || path.parent() == Some(profiles.as_path())
                });
                if changed && relevant {
                    let _ = sender.send(());
                }
            }
        })
        .map_err(|error| format!("Could not watch the config file: {error}"))?;
    // Watch directories: editors often save by replacing the file.
    let mut dirs: HashSet<&Path> = files.iter().filter_map(|file| file.parent()).collect();
    dirs.insert(profiles_dir);
    for dir in dirs.into_iter().filter(|dir| dir.is_dir()) {
        let _ = new_watcher.watch(dir, RecursiveMode::NonRecursive);
    }
    let app = app.clone();
    std::thread::spawn(move || {
        // Ends when the watcher (and with it the sender) is replaced or dropped.
        while receiver.recv().is_ok() {
            std::thread::sleep(RELOAD_DEBOUNCE);
            while receiver.try_recv().is_ok() {}
            let _ = app.emit("config-changed", ());
        }
    });
    *watcher
        .0
        .lock()
        .map_err(|_| "Config watcher lock was poisoned".to_string())? = Some(new_watcher);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ghostty_lines() {
        assert_eq!(
            parse_line("palette = 0=#21222c  "),
            Some(("palette".into(), "0=#21222c".into()))
        );
        assert_eq!(
            parse_line("cursor-style = \"block\""),
            Some(("cursor-style".into(), "block".into()))
        );
        assert_eq!(
            parse_line("font-family ="),
            Some(("font-family".into(), "".into()))
        );
        assert_eq!(parse_line("  # comment"), None);
        assert_eq!(parse_line(""), None);
    }

    #[test]
    fn follows_includes_once() {
        let dir = std::env::temp_dir().join(format!("hbox-config-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("config"),
            "font-size = 12\nconfig-file = extra\nconfig-file = ?missing\nconfig-file = config\n",
        )
        .unwrap();
        fs::write(dir.join("extra"), "theme = Dracula\n").unwrap();
        let mut loaded = LoadedConfig {
            path: String::new(),
            entries: Vec::new(),
            errors: Vec::new(),
            profiles: Vec::new(),
        };
        let mut files = Vec::new();
        read_entries(
            &dir.join("config"),
            0,
            &mut HashSet::new(),
            &mut loaded,
            &mut files,
        );
        let keys: Vec<_> = loaded
            .entries
            .iter()
            .map(|entry| entry.key.as_str())
            .collect();
        assert_eq!(keys, ["font-size", "theme"]);
        assert_eq!(loaded.errors.len(), 1, "{:?}", loaded.errors);
        assert!(files.contains(&dir.join("missing")));
        fs::remove_dir_all(dir).unwrap();
    }
}
