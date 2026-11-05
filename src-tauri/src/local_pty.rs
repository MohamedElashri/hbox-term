//! Local shell sessions on a pseudo-terminal.
//!
//! A session uses three threads:
//! - reader: blocking reads from the PTY, paused while too much output is unacknowledged
//! - writer: blocking writes of user input, so a child that stops reading stdin cannot
//!   stall output handling
//! - control: owns the PTY and child; batches output, applies resizes and handles close
//!
//! Sessions share the terminal session map and the input/resize/ack/close commands with
//! SSH sessions, so the frontend treats both the same way.

use crate::models::{LocalTerminalRequest, TerminalStarted};
use crate::pty_output::{OutputChannel, OutputPump, Unacked};
use crate::terminal::{self, TerminalActivity, TerminalCommand, TerminalSessions};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, OnceLock};
use std::thread;
use std::time::{Duration, Instant};
use uuid::Uuid;

/// Server id recorded for local sessions; never a valid server profile id.
pub const LOCAL_SERVER_ID: &str = "local";

const BACKPRESSURE_WAIT: Duration = Duration::from_millis(2);
const IDLE_WAIT: Duration = Duration::from_secs(1);
/// How long a shell gets to exit after its terminal hangs up before it is killed.
const HANGUP_GRACE: Duration = Duration::from_secs(2);

static INTEGRATION_DIR: OnceLock<PathBuf> = OnceLock::new();

/// The integration scripts, by path; also installed on servers by remote_integration.rs.
pub(crate) const INTEGRATION_FILES: [(&str, &str); 4] = [
    (
        "zsh/.zshenv",
        include_str!("../shell-integration/zsh/.zshenv"),
    ),
    (
        "fish/vendor_conf.d/ternway.fish",
        include_str!("../shell-integration/fish/vendor_conf.d/ternway.fish"),
    ),
    (
        "bash/ternway.bash",
        include_str!("../shell-integration/bash/ternway.bash"),
    ),
    (
        "bash/login.bash",
        include_str!("../shell-integration/bash/login.bash"),
    ),
];

/// Writes the shell integration scripts (refreshed on every start so they match this build).
pub fn install_shell_integration(data_dir: &Path) -> Result<(), String> {
    let root = write_shell_integration(data_dir)?;
    let _ = INTEGRATION_DIR.set(root);
    Ok(())
}

fn write_shell_integration(data_dir: &Path) -> Result<std::path::PathBuf, String> {
    let root = data_dir.join("shell-integration");
    for (path, contents) in INTEGRATION_FILES {
        let target = root.join(path);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("Could not create {}: {error}", parent.display()))?;
        }
        std::fs::write(&target, contents)
            .map_err(|error| format!("Could not write {}: {error}", target.display()))?;
    }
    Ok(root)
}

fn shell_name(program: &str) -> &str {
    Path::new(program)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("")
        .trim_start_matches('-')
}

/// Sets up OSC 133/OSC 7 integration for zsh (via ZDOTDIR) and fish (via XDG_DATA_DIRS); bash
/// is started with an rcfile in `start`. `TERNWAY_SHELL_INTEGRATION` points at the scripts.
fn apply_shell_integration(command: &mut CommandBuilder, mode: Option<&str>, program: &str) {
    let Some(root) = INTEGRATION_DIR.get() else {
        return;
    };
    apply_shell_integration_at(command, mode, program, root);
}

fn apply_shell_integration_at(
    command: &mut CommandBuilder,
    mode: Option<&str>,
    program: &str,
    root: &Path,
) {
    let mode = mode.unwrap_or("detect");
    if mode == "none" {
        return;
    }
    command.env("TERNWAY_SHELL_INTEGRATION", root);
    let shell = if mode == "detect" {
        shell_name(program)
    } else {
        mode
    };
    match shell {
        "zsh" => {
            if let Some(original) = std::env::var_os("ZDOTDIR") {
                command.env("TERNWAY_ZDOTDIR", original);
            }
            command.env("ZDOTDIR", root.join("zsh"));
        }
        "fish" => {
            let data_dir = root.join("fish");
            let existing = crate::appimage::host_var("XDG_DATA_DIRS")
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| "/usr/local/share:/usr/share".to_string());
            command.env(
                "XDG_DATA_DIRS",
                format!("{}:{existing}", data_dir.display()),
            );
            command.env("TERNWAY_FISH_DATA_DIR", data_dir);
        }
        _ => {}
    }
}

enum Event {
    Command(TerminalCommand),
    Output(Vec<u8>),
    Eof,
}

pub fn start(
    output: OutputChannel,
    sessions: TerminalSessions,
    request: LocalTerminalRequest,
) -> Result<TerminalStarted, String> {
    let custom = request
        .command
        .as_deref()
        .filter(|command| !command.trim().is_empty());
    let mut command = match custom {
        Some(program) => {
            let mut command = CommandBuilder::new("/bin/sh");
            command.args(["-c", &format!("exec {program}")]);
            command
        }
        // The user's login shell, as a terminal emulator would start it.
        None => CommandBuilder::new_default_prog(),
    };
    let program = match custom {
        Some(program) => program.split_whitespace().next().unwrap_or("").to_string(),
        None => command.get_shell(),
    };
    // bash reads no file we can redirect, so start it with an rcfile that acts like a login shell.
    let integration = request.shell_integration.as_deref().unwrap_or("detect");
    let bash = integration == "bash" || (integration == "detect" && shell_name(&program) == "bash");
    if custom.is_none() && bash {
        if let Some(root) = INTEGRATION_DIR.get() {
            command = CommandBuilder::new(&program);
            command.args([
                "--rcfile",
                &root.join("bash/login.bash").display().to_string(),
                "-i",
            ]);
        }
    }
    crate::appimage::apply(&mut command);
    apply_shell_integration(&mut command, request.shell_integration.as_deref(), &program);
    let home = dirs::home_dir();
    match request.cwd.as_deref().map(str::trim) {
        Some("home") | None | Some("") => {
            if let Some(home) = &home {
                command.cwd(home);
            }
        }
        Some(path) => match (path.strip_prefix("~/"), &home) {
            (Some(rest), Some(home)) => command.cwd(home.join(rest)),
            _ => command.cwd(path),
        },
    }
    for (key, value) in &request.env {
        command.env(key, value);
    }
    spawn(output, sessions, request, command, LOCAL_SERVER_ID)
}

pub(crate) fn spawn(
    output: OutputChannel,
    sessions: TerminalSessions,
    request: LocalTerminalRequest,
    mut command: CommandBuilder,
    server_id: &str,
) -> Result<TerminalStarted, String> {
    let session_id = Uuid::parse_str(&request.session_id)
        .map_err(|_| "Invalid terminal session identifier".to_string())?
        .to_string();
    let pty = native_pty_system()
        .openpty(PtySize {
            rows: request.rows.max(5) as u16,
            cols: request.cols.max(20) as u16,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| format!("Could not open a pseudo-terminal: {error}"))?;
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    command.env("TERM_PROGRAM", "ternway");
    command.env("TERM_PROGRAM_VERSION", env!("CARGO_PKG_VERSION"));
    let expected_program = program_name(&command);
    let child = pty
        .slave
        .spawn_command(command)
        .map_err(|error| format!("Could not start your shell: {error}"))?;
    // The child holds its own copy of the slave side; ours must close so EOF is seen.
    drop(pty.slave);
    let master = pty.master;
    let reader = master
        .try_clone_reader()
        .map_err(|error| format!("Could not read from the pseudo-terminal: {error}"))?;
    let writer = master
        .take_writer()
        .map_err(|error| format!("Could not write to the pseudo-terminal: {error}"))?;

    let (events, receiver) = mpsc::sync_channel(64);
    let (commands, command_receiver) = mpsc::channel();
    let pending_input_bytes = Arc::new(AtomicUsize::new(0));
    let unacked = Unacked::default();
    terminal::register(
        &sessions,
        &session_id,
        server_id,
        commands,
        pending_input_bytes.clone(),
        unacked.clone(),
    )?;

    // Commands arrive on their own channel; forward them into the event loop.
    let forward = events.clone();
    thread::spawn(move || {
        for command in command_receiver {
            if forward.send(Event::Command(command)).is_err() {
                break;
            }
        }
    });
    spawn_reader(reader, events, unacked.clone());
    let input = spawn_writer(writer, pending_input_bytes);
    let thread_session_id = session_id.clone();
    thread::spawn(move || {
        run(
            receiver,
            OutputPump::new(output, unacked),
            master,
            child,
            input,
            request
                .command
                .as_deref()
                .is_none_or(|command| command.trim().is_empty()),
            expected_program,
        );
        terminal::unregister(&sessions, &thread_session_id);
    });
    Ok(TerminalStarted {
        session_id,
        server_id: server_id.to_string(),
    })
}

fn spawn_reader(
    mut reader: Box<dyn Read + Send>,
    events: mpsc::SyncSender<Event>,
    unacked: Unacked,
) {
    thread::spawn(move || {
        let mut buffer = vec![0u8; 64 * 1024];
        loop {
            while unacked.saturated() && !unacked.stopped() {
                thread::sleep(BACKPRESSURE_WAIT);
            }
            if unacked.stopped() {
                break;
            }
            match reader.read(&mut buffer) {
                // Linux reports EIO once the child side has closed.
                Ok(0) | Err(_) => break,
                Ok(size) => {
                    if events.send(Event::Output(buffer[..size].to_vec())).is_err() {
                        return;
                    }
                }
            }
        }
        let _ = events.send(Event::Eof);
    });
}

fn spawn_writer(
    mut writer: Box<dyn Write + Send>,
    pending_input_bytes: Arc<AtomicUsize>,
) -> mpsc::Sender<Vec<u8>> {
    let (sender, receiver) = mpsc::channel::<Vec<u8>>();
    thread::spawn(move || {
        for data in receiver {
            let written = writer.write_all(&data).and_then(|()| writer.flush());
            pending_input_bytes.fetch_sub(data.len(), Ordering::Relaxed);
            if written.is_err() {
                break;
            }
        }
    });
    sender
}

fn run(
    events: mpsc::Receiver<Event>,
    mut pump: OutputPump,
    master: Box<dyn MasterPty + Send>,
    mut child: Box<dyn Child + Send + Sync>,
    input: mpsc::Sender<Vec<u8>>,
    shell: bool,
    expected_program: String,
) {
    let mut wait = IDLE_WAIT;
    let close_message = loop {
        match events.recv_timeout(wait) {
            Ok(Event::Output(data)) => pump.push(&data),
            Ok(Event::Command(TerminalCommand::Input(data))) => {
                let _ = input.send(data);
            }
            Ok(Event::Command(TerminalCommand::Resize(cols, rows))) => {
                let _ = master.resize(PtySize {
                    rows: rows.max(5) as u16,
                    cols: cols.max(20) as u16,
                    pixel_width: 0,
                    pixel_height: 0,
                });
            }
            Ok(Event::Command(TerminalCommand::Activity(reply))) => {
                let _ = reply.send(job_activity(
                    master.as_ref(),
                    child.as_mut(),
                    shell,
                    &expected_program,
                ));
            }
            Ok(Event::Command(TerminalCommand::Wake)) => {}
            Ok(Event::Command(TerminalCommand::Close)) => break None,
            Ok(Event::Eof) => break Some(exit_message(child.as_mut())),
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break None,
        }
        wait = pump.flush_if_due().unwrap_or(IDLE_WAIT);
    };
    match close_message {
        Some(message) => pump.close(&message),
        None => {
            // Hang up the terminal so the shell can exit cleanly (and save history).
            drop(input);
            drop(master);
            hang_up(child);
        }
    }
}

fn program_name(command: &CommandBuilder) -> String {
    let program = if command.is_default_prog() {
        command.get_shell()
    } else {
        command
            .get_argv()
            .first()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default()
    };
    Path::new(&program)
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .trim_start_matches('-')
        .to_string()
}

fn job_activity(
    master: &dyn MasterPty,
    child: &mut (dyn Child + Send + Sync),
    shell: bool,
    expected_program: &str,
) -> TerminalActivity {
    if child.try_wait().is_ok_and(|status| status.is_some()) {
        return TerminalActivity::Closed;
    }
    if !shell {
        return TerminalActivity::Busy;
    }
    let Some(pid) = child.process_id() else {
        return TerminalActivity::Unknown;
    };
    match master.process_group_leader() {
        Some(group) if group != pid as i32 => return TerminalActivity::Busy,
        None => return TerminalActivity::Unknown,
        _ => {}
    }
    let mut probe = std::process::Command::new("/usr/bin/pgrep");
    probe.args(["-P", &pid.to_string()]);
    match crate::child_process::run(probe, None, 8192, Duration::from_secs(1), None) {
        Ok(output) if output.exit_code == 0 => TerminalActivity::Busy,
        Ok(output) if output.exit_code == 1 => {
            // exec replaces an idle shell without changing its PID or process group.
            // Read only the executable name, never command arguments or environment.
            let mut probe = std::process::Command::new("/bin/ps");
            probe.args(["-p", &pid.to_string(), "-o", "comm="]);
            match crate::child_process::run(probe, None, 4096, Duration::from_secs(1), None) {
                Ok(output) if output.exit_code == 0 => {
                    let name = Path::new(output.stdout.trim())
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy();
                    if name.trim_start_matches('-') == expected_program {
                        TerminalActivity::Idle
                    } else {
                        TerminalActivity::Busy
                    }
                }
                _ => TerminalActivity::Unknown,
            }
        }
        _ => TerminalActivity::Unknown,
    }
}

fn exit_message(child: &mut (dyn Child + Send + Sync)) -> String {
    match child.wait() {
        Ok(status) => match status.signal() {
            Some(signal) => format!("Process exited: {signal}"),
            None if status.success() => "Process exited".to_string(),
            None => format!("Process exited with code {}", status.exit_code()),
        },
        Err(_) => "Process exited".to_string(),
    }
}

fn hang_up(mut child: Box<dyn Child + Send + Sync>) {
    let deadline = Instant::now() + HANGUP_GRACE;
    while Instant::now() < deadline {
        if !matches!(child.try_wait(), Ok(None)) {
            return;
        }
        thread::sleep(Duration::from_millis(50));
    }
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;
    use tauri::ipc::{Channel, InvokeResponseBody};

    #[test]
    fn closing_a_saturated_pump_releases_its_reader_without_an_ack() {
        let unacked = Unacked::default();
        let mut pump = OutputPump::new(Channel::new(|_| Ok(())), unacked.clone());
        pump.push(&vec![b'x'; 4 * 1024 * 1024]);
        pump.flush_if_due();
        assert!(unacked.saturated());
        let (events, received) = mpsc::sync_channel(4);
        spawn_reader(Box::new(std::io::Cursor::new(vec![1u8])), events, unacked);
        assert!(received.recv_timeout(Duration::from_millis(20)).is_err());
        drop(pump);
        assert!(matches!(
            received.recv_timeout(Duration::from_secs(1)).unwrap(),
            Event::Eof
        ));
    }

    #[test]
    fn default_login_shell_has_a_real_program_name_for_idle_detection() {
        let mut command = CommandBuilder::new_default_prog();
        command.env("SHELL", "/bin/sh");
        assert_eq!(program_name(&command), "sh");
        assert_eq!(program_name(&CommandBuilder::new("/bin/zsh")), "zsh");
        assert_eq!(program_name(&CommandBuilder::new("-zsh")), "zsh");
    }

    struct Fixture {
        sessions: TerminalSessions,
        id: String,
        output: mpsc::Receiver<Vec<u8>>,
    }
    impl Fixture {
        fn new() -> Self {
            let sessions: TerminalSessions = Arc::new(Mutex::new(HashMap::new()));
            let id = Uuid::new_v4().to_string();
            let (send, output) = mpsc::channel();
            let channel = Channel::new(move |body| {
                if let InvokeResponseBody::Raw(bytes) = body {
                    let _ = send.send(bytes);
                }
                Ok(())
            });
            let request = LocalTerminalRequest {
                session_id: id.clone(),
                cols: 80,
                rows: 24,
                cwd: None,
                command: None,
                env: vec![],
                shell_integration: Some("none".into()),
            };
            let mut command = CommandBuilder::new("/bin/sh");
            command.arg("-i");
            command.env("PS1", "");
            command.env("ENV", "/dev/null");
            command.env("BASH_ENV", "/dev/null");
            spawn(channel, sessions.clone(), request, command, LOCAL_SERVER_ID).unwrap();
            let fixture = Self {
                sessions,
                id,
                output,
            };
            fixture.input("stty -echo; printf 'fixture-ready\\n'\n");
            fixture.until(b"fixture-ready\r\n");
            fixture
        }
        fn input(&self, text: &str) {
            terminal::input(&self.sessions, &self.id, text.into()).unwrap();
        }
        fn until(&self, marker: &[u8]) -> Vec<u8> {
            let deadline = Instant::now() + Duration::from_secs(15);
            let mut bytes = Vec::new();
            loop {
                let frame = self
                    .output
                    .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                    .expect("Fixture output timed out");
                if frame[0] == 0 {
                    bytes.extend_from_slice(&frame[1..]);
                    let _ = terminal::ack(&self.sessions, &self.id, frame.len() - 1);
                    if bytes.windows(marker.len()).any(|w| w == marker) {
                        return bytes;
                    }
                } else {
                    panic!("Fixture closed early: {}", String::from_utf8_lossy(&bytes));
                }
            }
        }
        fn activity(&self) -> TerminalActivity {
            terminal::activities(&self.sessions, std::slice::from_ref(&self.id)).unwrap()[&self.id]
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = terminal::input(&self.sessions, &self.id, "\x03exit\n".into());
            let _ = terminal::close(&self.sessions, &self.id);
        }
    }

    #[test]
    fn activity_detects_foreground_and_background_jobs_without_terminal_input() {
        let fixture = Fixture::new();
        assert_eq!(fixture.activity(), TerminalActivity::Idle);
        fixture.input("sleep 2 & printf 'background-ready\\n'\n");
        fixture.until(b"background-ready\r\n");
        assert_eq!(fixture.activity(), TerminalActivity::Busy);
        fixture.input("wait; printf 'background-finished\\n'\n");
        fixture.until(b"background-finished\r\n");
        assert_eq!(fixture.activity(), TerminalActivity::Idle);
        fixture.input("printf 'foreground-ready\\n'; sleep 2\n");
        fixture.until(b"foreground-ready\r\n");
        let deadline = Instant::now() + Duration::from_secs(1);
        while fixture.activity() != TerminalActivity::Busy {
            assert!(Instant::now() < deadline);
            thread::sleep(Duration::from_millis(10));
        }
        fixture.input("\x03printf 'foreground-finished\\n'\n");
        fixture.until(b"foreground-finished\r\n");
        assert_eq!(fixture.activity(), TerminalActivity::Idle);
    }

    #[test]
    fn exec_replacing_the_shell_is_still_an_active_job() {
        let fixture = Fixture::new();
        fixture.input("exec sleep 2\n");
        let deadline = Instant::now() + Duration::from_secs(1);
        while fixture.activity() != TerminalActivity::Busy {
            assert!(Instant::now() < deadline);
            thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn large_output_unicode_alternate_screen_and_resize_survive_backpressure() {
        let fixture = Fixture::new();
        for n in 0..100 {
            terminal::resize(
                &fixture.sessions,
                crate::models::TerminalResize {
                    session_id: fixture.id.clone(),
                    cols: 80 + n % 40,
                    rows: 24 + n % 20,
                },
            )
            .unwrap();
        }
        terminal::resize(
            &fixture.sessions,
            crate::models::TerminalResize {
                session_id: fixture.id.clone(),
                cols: 132,
                rows: 43,
            },
        )
        .unwrap();
        let block = "x".repeat(512);
        fixture.input(&format!("n=0; while [ $n -lt 12000 ]; do printf '%s' '{block}'; n=$((n+1)); done; printf '\\033[?1049h漢字🙂 é\\033[?1049l\\n'; stty size; printf 'stress-finished\\n'\n"));
        // Let the producer reach backpressure before acknowledging frames.
        thread::sleep(Duration::from_millis(100));
        let bytes = fixture.until(b"stress-finished\r\n");
        assert_eq!(
            bytes.iter().filter(|byte| **byte == b'x').count(),
            12000 * 512
        );
        let text =
            String::from_utf8(bytes).expect("PTY data must retain UTF-8 bytes across frames");
        assert!(text.contains("\x1b[?1049h漢字🙂 é\x1b[?1049l"));
        assert!(text.contains("43 132"));
    }

    fn run_shell(script: &str) -> (String, String) {
        let (frames, received) = mpsc::channel();
        let output = Channel::new(move |body| {
            if let InvokeResponseBody::Raw(bytes) = body {
                let _ = frames.send(bytes);
            }
            Ok(())
        });
        let sessions: TerminalSessions = Arc::new(Mutex::new(HashMap::new()));
        let session_id = Uuid::new_v4().to_string();
        let request = LocalTerminalRequest {
            session_id: session_id.clone(),
            cols: 80,
            rows: 24,
            cwd: None,
            command: None,
            env: Vec::new(),
            shell_integration: None,
        };
        let mut command = CommandBuilder::new("/bin/sh");
        command.env("PS1", "$ ");
        spawn(output, sessions.clone(), request, command, LOCAL_SERVER_ID).expect("shell starts");
        terminal::input(&sessions, &session_id, script.to_string()).expect("input accepted");

        let mut text = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let frame = received
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .expect("shell output before timeout");
            match frame[0] {
                0 => text.extend_from_slice(&frame[1..]),
                _ => {
                    let message = String::from_utf8_lossy(&frame[1..]).into_owned();
                    return (String::from_utf8_lossy(&text).into_owned(), message);
                }
            }
        }
    }

    #[test]
    fn zsh_integration_marks_prompts_and_exit_codes() {
        if std::process::Command::new("zsh")
            .arg("--version")
            .output()
            .is_err()
        {
            return;
        }
        let home = std::env::temp_dir().join(format!("ternway-zsh-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&home).unwrap();
        write_shell_integration(&home).unwrap();
        let (frames, received) = mpsc::channel();
        let output = Channel::new(move |body| {
            if let InvokeResponseBody::Raw(bytes) = body {
                let _ = frames.send(bytes);
            }
            Ok(())
        });
        let sessions: TerminalSessions = Arc::new(Mutex::new(HashMap::new()));
        let session_id = Uuid::new_v4().to_string();
        let request = LocalTerminalRequest {
            session_id: session_id.clone(),
            cols: 80,
            rows: 24,
            cwd: None,
            command: None,
            env: Vec::new(),
            shell_integration: Some("zsh".into()),
        };
        let mut command = CommandBuilder::new("zsh");
        command.arg("-i");
        // An empty HOME keeps the developer's own zsh configuration out of the test.
        command.env("HOME", &home);
        command.env_remove("ZDOTDIR");
        apply_shell_integration_at(
            &mut command,
            request.shell_integration.as_deref(),
            "zsh",
            &home.join("shell-integration"),
        );
        spawn(output, sessions.clone(), request, command, LOCAL_SERVER_ID).expect("zsh starts");
        terminal::input(&sessions, &session_id, "true\nfalse\nexit\n".into()).unwrap();
        let mut text = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(10);
        while let Ok(frame) =
            received.recv_timeout(deadline.saturating_duration_since(Instant::now()))
        {
            if frame[0] != 0 {
                break;
            }
            text.extend_from_slice(&frame[1..]);
        }
        let text = String::from_utf8_lossy(&text);
        assert!(text.contains("\x1b]133;A\x07"), "no prompt mark: {text:?}");
        assert!(text.contains("\x1b]133;C\x07"), "no command mark: {text:?}");
        assert!(
            text.contains("\x1b]133;D;0\x07"),
            "no success mark: {text:?}"
        );
        assert!(
            text.contains("\x1b]133;D;1\x07"),
            "no failure mark: {text:?}"
        );
        assert!(
            text.contains("\x1b]7;file://"),
            "no directory report: {text:?}"
        );
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn bash_integration_through_the_login_rcfile() {
        assert_bash_integration("bash");
        // The system Bash is 3.2 on macOS, even when Homebrew Bash is on PATH.
        #[cfg(target_os = "macos")]
        assert_bash_integration("/bin/bash");
    }

    fn assert_bash_integration(program: &str) {
        let home = std::env::temp_dir().join(format!("ternway-bash-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(
            home.join(".bash_profile"),
            "PROMPT_COMMAND=': user-prompt'\n",
        )
        .unwrap();
        write_shell_integration(&home).unwrap();
        let root = home.join("shell-integration");
        let (frames, received) = mpsc::channel();
        let output = Channel::new(move |body| {
            if let InvokeResponseBody::Raw(bytes) = body {
                let _ = frames.send(bytes);
            }
            Ok(())
        });
        let sessions: TerminalSessions = Arc::new(Mutex::new(HashMap::new()));
        let session_id = Uuid::new_v4().to_string();
        let request = LocalTerminalRequest {
            session_id: session_id.clone(),
            cols: 80,
            rows: 24,
            cwd: None,
            command: None,
            env: Vec::new(),
            shell_integration: Some("bash".into()),
        };
        let mut command = CommandBuilder::new(program);
        command.args([
            "--rcfile",
            &root.join("bash/login.bash").display().to_string(),
            "-i",
        ]);
        command.env("HOME", &home);
        spawn(output, sessions.clone(), request, command, LOCAL_SERVER_ID).expect("bash starts");
        terminal::input(&sessions, &session_id, "true\nfalse\nexit\n".into()).unwrap();
        let mut text = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(10);
        while let Ok(frame) =
            received.recv_timeout(deadline.saturating_duration_since(Instant::now()))
        {
            if frame[0] != 0 {
                break;
            }
            text.extend_from_slice(&frame[1..]);
        }
        let text = String::from_utf8_lossy(&text);
        assert!(text.contains("\x1b]133;A\x07"), "no prompt mark: {text:?}");
        assert_eq!(
            text.matches("\x1b]133;C\x07").count(),
            3,
            "expected one command mark for each input line, excluding prompt hooks: {text:?}"
        );
        assert!(
            text.contains("\x1b]133;D;1\x07"),
            "no failure mark: {text:?}"
        );
        assert!(
            text.contains("\x1b]7;file://"),
            "no directory report: {text:?}"
        );
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn runs_input_and_reports_exit() {
        let (output, message) = run_shell("echo ternway-$((40 + 2))\nexit 3\n");
        assert!(
            output.contains("ternway-42"),
            "unexpected output: {output:?}"
        );
        assert_eq!(message, "Process exited with code 3");
    }

    #[test]
    fn sets_terminal_environment() {
        let (output, _) = run_shell("echo \"$TERM|$COLORTERM|$TERM_PROGRAM\"\nexit\n");
        assert!(
            output.contains("xterm-256color|truecolor|ternway"),
            "unexpected output: {output:?}"
        );
    }
}
