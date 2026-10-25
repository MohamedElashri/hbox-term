//! Opening files in the user's editor: for links in the terminal (`file:line`) and for remote
//! files edited locally.
//!
//! The editor is the `editor` config key, else `$VISUAL`/`$EDITOR` as the user's login shell
//! sets them (detected once; GUI launches often lack shell startup variables). Terminal editors
//! run in a pane; GUI editors are started directly.

use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

static DETECTED: OnceLock<String> = OnceLock::new();
const MARKER: &str = "__HBOX_EDITOR__";
const DETECT_TIMEOUT: Duration = Duration::from_secs(3);

/// Editors with their own window; everything else is assumed to run in a terminal.
const GUI_EDITORS: [&str; 10] = [
    "code",
    "code-insiders",
    "codium",
    "cursor",
    "windsurf",
    "zed",
    "zeditor",
    "subl",
    "gedit",
    "kate",
];

pub fn user_shell() -> String {
    std::env::var("SHELL")
        .ok()
        .filter(|shell| !shell.is_empty())
        .unwrap_or_else(|| portable_pty::CommandBuilder::new_default_prog().get_shell())
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', r"'\''"))
}

fn program_name(editor: &str) -> &str {
    let program = editor.split_whitespace().next().unwrap_or("");
    Path::new(program)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(program)
}

pub fn is_gui_editor(editor: &str) -> bool {
    GUI_EDITORS.contains(&program_name(editor))
}

fn on_path(name: &str) -> bool {
    std::env::var_os("PATH")
        .is_some_and(|paths| std::env::split_paths(&paths).any(|dir| dir.join(name).is_file()))
}

/// `$VISUAL`/`$EDITOR` from an interactive login shell, so values set in .zshrc count.
fn detect() -> String {
    let shell = user_shell();
    let script = if shell.ends_with("/fish") {
        format!(
            "set -l e $VISUAL; test -n \"$e\"; or set e $EDITOR; printf '\\n{MARKER}%s\\n' \"$e\""
        )
    } else {
        format!("printf '\\n{MARKER}%s\\n' \"${{VISUAL:-$EDITOR}}\"")
    };
    let mut command = Command::new(&shell);
    crate::appimage::apply_std(&mut command);
    let Ok(mut child) = command
        .args(["-lic", &script])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    else {
        return String::new();
    };
    let started = Instant::now();
    while started.elapsed() < DETECT_TIMEOUT {
        if matches!(child.try_wait(), Ok(Some(_))) {
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let _ = child.kill();
    let mut output = String::new();
    if let Some(mut stdout) = child.stdout.take() {
        let _ = stdout.read_to_string(&mut output);
    }
    let _ = child.wait();
    output
        .lines()
        .find_map(|line| line.strip_prefix(MARKER))
        .map(|editor| editor.trim().to_string())
        .unwrap_or_default()
}

/// The editor command line: the configured one, else the detected one, else `vi`.
pub fn editor(configured: Option<&str>) -> String {
    if let Some(editor) = configured
        .map(str::trim)
        .filter(|editor| !editor.is_empty())
    {
        return editor.to_string();
    }
    DETECTED
        .get_or_init(|| {
            let detected = detect();
            if !detected.is_empty() {
                return detected;
            }
            // No $VISUAL/$EDITOR: the first common terminal editor that is installed.
            ["nvim", "vim", "nano", "vi"]
                .into_iter()
                .find(|name| on_path(name))
                .unwrap_or("vi")
                .to_string()
        })
        .clone()
}

/// The editor's command line for a file, at a line and column when given. `wait` keeps GUI
/// editors running until the file is closed (needed when edits are synced on exit).
pub fn invocation(
    editor: &str,
    path: &str,
    line: Option<u32>,
    column: Option<u32>,
    wait: bool,
) -> String {
    let name = program_name(editor);
    let location = match (line, column) {
        (Some(line), Some(column)) => format!("{path}:{line}:{column}"),
        (Some(line), None) => format!("{path}:{line}"),
        _ => path.to_string(),
    };
    let wait_flag =
        if wait && is_gui_editor(editor) && !editor.contains("--wait") && !editor.contains(" -w") {
            " --wait"
        } else {
            ""
        };
    match name {
        "code" | "code-insiders" | "codium" | "cursor" | "windsurf" => {
            let goto = if line.is_some() { " --goto" } else { "" };
            format!("{editor}{wait_flag}{goto} {}", shell_quote(&location))
        }
        "zed" | "zeditor" | "subl" | "hx" | "helix" => {
            format!("{editor}{wait_flag} {}", shell_quote(&location))
        }
        _ => match line {
            Some(line) => format!("{editor}{wait_flag} +{line} {}", shell_quote(path)),
            None => format!("{editor}{wait_flag} {}", shell_quote(path)),
        },
    }
}

/// Runs an editor invocation through the login shell so its PATH and variables apply.
pub fn login_shell_command(invocation: &str) -> String {
    format!(
        "{} -lic {}",
        user_shell(),
        shell_quote(&format!("exec {invocation}"))
    )
}

/// Starts a GUI editor without a terminal.
pub fn spawn_detached(invocation: &str) -> Result<(), String> {
    let mut command = Command::new(user_shell());
    crate::appimage::apply_std(&mut command);
    command
        .args(["-lc", &format!("exec {invocation}")])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Could not start the editor: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_editors_take_plus_line() {
        assert_eq!(
            invocation("nvim", "/src/a b.rs", Some(12), Some(3), false),
            "nvim +12 '/src/a b.rs'"
        );
        assert_eq!(
            invocation("/usr/bin/vim -p", "/x", None, None, true),
            "/usr/bin/vim -p '/x'"
        );
    }

    #[test]
    fn gui_and_location_editors() {
        assert_eq!(
            invocation("code", "/x.ts", Some(4), Some(2), false),
            "code --goto '/x.ts:4:2'"
        );
        assert_eq!(
            invocation("code", "/x.ts", None, None, true),
            "code --wait '/x.ts'"
        );
        assert_eq!(
            invocation("code --wait", "/x.ts", Some(4), None, true),
            "code --wait --goto '/x.ts:4'"
        );
        assert_eq!(
            invocation("hx", "/x.rs", Some(9), None, false),
            "hx '/x.rs:9'"
        );
        assert_eq!(
            invocation("zed", "/x", Some(1), None, true),
            "zed --wait '/x:1'"
        );
        assert!(is_gui_editor("/snap/bin/code --new-window"));
        assert!(!is_gui_editor("nvim"));
    }

    #[test]
    fn quoting_round_trips_through_sh() {
        for value in ["plain", "it's", "a b", "'", "$HOME `x` \\"] {
            let output = Command::new("/bin/sh")
                .args(["-c", &format!("printf %s {}", shell_quote(value))])
                .output()
                .unwrap();
            assert_eq!(String::from_utf8_lossy(&output.stdout), value);
        }
    }

    #[test]
    fn configured_editor_wins() {
        assert_eq!(editor(Some(" code --wait ")), "code --wait");
    }
}
