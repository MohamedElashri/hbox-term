//! The AppImage starts hbox-term with its runtime's environment: library, Python, GTK and data
//! paths inside the image, plus a few settings of its own. hbox-term needs them, but shells and
//! editors started from it must see the user's environment, or for example Python finds the
//! image's `PYTHONHOME` and fails to start.

use std::sync::OnceLock;

/// Set by the AppImage runtime or its GTK hook without pointing into the image.
const RUNTIME_ONLY: &[&str] = &[
    "APPDIR",
    "APPIMAGE",
    "ARGV0",
    "OWD",
    "GTK_THEME",
    "PYTHONDONTWRITEBYTECODE",
];

/// Changes for child processes: `None` removes the variable. Empty outside an AppImage.
pub fn child_env() -> &'static [(String, Option<String>)] {
    static CHANGES: OnceLock<Vec<(String, Option<String>)>> = OnceLock::new();
    CHANGES.get_or_init(|| match std::env::var("APPDIR") {
        Ok(appdir) if !appdir.is_empty() && std::env::var_os("APPIMAGE").is_some() => {
            changes(std::env::vars(), &appdir)
        }
        _ => Vec::new(),
    })
}

/// A variable as child processes see it.
pub fn host_var(name: &str) -> Option<String> {
    match child_env().iter().find(|(key, _)| key == name) {
        Some((_, value)) => value.clone(),
        None => std::env::var(name).ok(),
    }
}

pub fn apply(command: &mut portable_pty::CommandBuilder) {
    for (key, value) in child_env() {
        match value {
            Some(value) => command.env(key, value),
            None => command.env_remove(key),
        }
    }
}

pub fn apply_std(command: &mut std::process::Command) {
    for (key, value) in child_env() {
        match value {
            Some(value) => command.env(key, value),
            None => command.env_remove(key),
        };
    }
}

fn changes(
    vars: impl Iterator<Item = (String, String)>,
    appdir: &str,
) -> Vec<(String, Option<String>)> {
    let appdir = appdir.trim_end_matches('/');
    let mut changes = Vec::new();
    for (key, value) in vars {
        if RUNTIME_ONLY.contains(&key.as_str()) {
            changes.push((key, None));
        } else if value.contains(appdir) {
            // Path lists lose the image's entries; anything left empty was the image's alone.
            let kept: Vec<&str> = value
                .split(':')
                .filter(|entry| !entry.is_empty() && !entry.starts_with(appdir))
                .collect();
            changes.push((key, (!kept.is_empty()).then(|| kept.join(":"))));
        }
    }
    changes
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(vars: &[(&str, &str)]) -> Vec<(String, Option<String>)> {
        let vars = vars.iter().map(|(k, v)| (k.to_string(), v.to_string()));
        changes(vars, "/tmp/.mount_hbox/")
    }

    #[test]
    fn removes_image_paths_and_runtime_settings() {
        let changes = run(&[
            ("PATH", "/tmp/.mount_hbox/usr/bin/:/usr/local/bin:/usr/bin"),
            ("PYTHONHOME", "/tmp/.mount_hbox/usr/"),
            (
                "LD_LIBRARY_PATH",
                "/tmp/.mount_hbox/usr/lib/:/tmp/.mount_hbox/lib/:",
            ),
            (
                "XDG_DATA_DIRS",
                "/tmp/.mount_hbox/usr/share:/usr/share:/usr/local/share",
            ),
            ("GTK_THEME", "Adwaita:dark"),
            ("APPIMAGE", "/home/me/hbox-term.AppImage"),
            ("HOME", "/home/me"),
            ("EDITOR", "nvim"),
        ]);
        let get = |name: &str| {
            changes
                .iter()
                .find(|(key, _)| key == name)
                .map(|(_, v)| v.clone())
        };
        assert_eq!(get("PATH"), Some(Some("/usr/local/bin:/usr/bin".into())));
        assert_eq!(get("PYTHONHOME"), Some(None));
        assert_eq!(get("LD_LIBRARY_PATH"), Some(None));
        assert_eq!(
            get("XDG_DATA_DIRS"),
            Some(Some("/usr/share:/usr/local/share".into()))
        );
        assert_eq!(get("GTK_THEME"), Some(None));
        assert_eq!(get("APPIMAGE"), Some(None));
        assert_eq!(get("HOME"), None);
        assert_eq!(get("EDITOR"), None);
    }
}
