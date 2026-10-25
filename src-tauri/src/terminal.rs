use crate::local_pty::LOCAL_SERVER_ID;
use crate::models::{TerminalRequest, TerminalResize, TerminalStarted};
use crate::pty_output::{OutputChannel, OutputPump, Unacked};
use crate::ssh::{begin_operation, finish_operation, SshClient, KEEPALIVE_INTERVAL_SECONDS};
use crate::storage::Store;
use ssh2::{ErrorCode, ExtendedData};
use std::collections::{HashMap, VecDeque};
use std::io::{ErrorKind, Read, Write};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    mpsc, Arc, Mutex,
};
use std::thread;
use std::time::{Duration, Instant};
use uuid::Uuid;

#[derive(Debug)]
pub enum TerminalCommand {
    Input(Vec<u8>),
    Resize(u32, u32),
    /// Output was acknowledged; wakes a session paused by flow control.
    Wake,
    Close,
}

const MAX_PENDING_INPUT_BYTES: usize = 1024 * 1024;
const MAX_KEEPALIVE_FAILURES: u8 = 3;
const KEEPALIVE_RETRY_DELAY: Duration = Duration::from_secs(1);
/// Longest idle wait between polls of the SSH channel. Waits start at
/// `MIN_POLL_INTERVAL` after activity and double up to this while idle; input
/// wakes the session immediately.
const MAX_POLL_INTERVAL: Duration = Duration::from_millis(12);
const MIN_POLL_INTERVAL: Duration = Duration::from_millis(1);

#[derive(Clone)]
pub struct TerminalSession {
    server_id: String,
    sender: mpsc::Sender<TerminalCommand>,
    pending_input_bytes: Arc<AtomicUsize>,
    unacked: Unacked,
}

pub type TerminalSessions = Arc<Mutex<HashMap<String, TerminalSession>>>;

pub fn start(
    output: OutputChannel,
    store: Store,
    sessions: TerminalSessions,
    request: TerminalRequest,
    operation_id: Option<&str>,
) -> Result<TerminalStarted, String> {
    let session_id = Uuid::parse_str(&request.session_id)
        .map_err(|_| "Invalid terminal session identifier".to_string())?
        .to_string();
    let (sender, receiver) = mpsc::channel();
    let pending_input_bytes = Arc::new(AtomicUsize::new(0));
    let unacked = Unacked::default();
    let profile = store.get_server(&request.server_id)?;
    let operation = begin_operation(operation_id);
    let cancellation = operation.as_ref().map(|operation| operation.cancellation());
    let mut client =
        match SshClient::connect_with_cancellation(&profile, cancellation.as_ref(), &store) {
            Ok(client) => client,
            Err(error) => {
                finish_operation(operation);
                return Err(error);
            }
        };
    let command = request.command.filter(|value| !value.trim().is_empty());
    // Integration is best effort: without SFTP, or on odd home paths, the shell starts plainly.
    let launcher = (request.shell_integration && command.is_none())
        .then(|| crate::remote_integration::prepare(&client))
        .and_then(|prepared| {
            prepared
                .map_err(|error| eprintln!("hbox-term remote shell integration: {error}"))
                .ok()
        })
        .and_then(|dir| crate::remote_integration::command(&dir, request.cwd.as_deref()));
    let mut channel = match client.open_channel() {
        Ok(channel) => channel,
        Err(error) => {
            finish_operation(operation);
            return Err(error);
        }
    };
    if let Some(cancellation) = cancellation.as_ref() {
        if cancellation.load(std::sync::atomic::Ordering::SeqCst) {
            finish_operation(operation);
            return Err(crate::ssh::OPERATION_CANCELLED.to_string());
        }
    }
    if let Err(error) =
        SshClient::request_pty(&mut channel, request.cols.max(20), request.rows.max(5))
    {
        finish_operation(operation);
        return Err(error);
    }
    let channel_start = if let Some(command) = command.as_deref().or(launcher.as_deref()) {
        channel
            .exec(command)
            .map_err(|error| format!("Could not start the remote command: {error}"))
    } else {
        channel
            .shell()
            .map_err(|error| format!("Could not start the remote shell: {error}"))
    };
    if let Err(error) = channel_start {
        finish_operation(operation);
        return Err(error);
    }
    if let Err(error) = channel
        .handle_extended_data(ExtendedData::Merge)
        .map_err(|error| format!("Could not prepare terminal output: {error}"))
    {
        finish_operation(operation);
        return Err(error);
    }
    client
        .session_mut()
        .set_keepalive(true, KEEPALIVE_INTERVAL_SECONDS);
    if let Err(error) = client.set_nonblocking() {
        finish_operation(operation);
        return Err(error);
    }
    if let Err(error) = sessions
        .lock()
        .map_err(|_| "Terminal session lock was poisoned".to_string())
        .map(|mut sessions| {
            sessions.insert(
                session_id.clone(),
                TerminalSession {
                    server_id: request.server_id.clone(),
                    sender,
                    pending_input_bytes: pending_input_bytes.clone(),
                    unacked: unacked.clone(),
                },
            )
        })
    {
        finish_operation(operation);
        return Err(error);
    }
    if cancellation
        .as_ref()
        .is_some_and(|value| value.load(std::sync::atomic::Ordering::SeqCst))
    {
        if let Ok(mut sessions) = sessions.lock() {
            sessions.remove(&session_id);
        }
        let _ = channel.close();
        finish_operation(operation);
        return Err(crate::ssh::OPERATION_CANCELLED.to_string());
    }
    finish_operation(operation);

    let thread_session_id = session_id.clone();
    let thread_sessions = sessions.clone();
    thread::spawn(move || {
        let mut pump = OutputPump::new(output, unacked);
        let mut buffer = [0u8; 64 * 1024];
        let mut pending_input = VecDeque::<(Vec<u8>, usize)>::new();
        let mut pending_resize = None;
        let mut retrying_input_write = false;
        let mut next_command = None;
        let mut idle_wait = MIN_POLL_INTERVAL;
        let mut next_keepalive =
            Instant::now() + Duration::from_secs(KEEPALIVE_INTERVAL_SECONDS.into());
        let mut keepalive_failures = 0u8;
        let mut closed = false;
        let mut close_message = None;
        while !closed {
            let mut progress = false;
            while let Some(command) = next_command.take().or_else(|| receiver.try_recv().ok()) {
                match command {
                    TerminalCommand::Input(data) => {
                        if !data.is_empty() {
                            pending_input.push_back((data, 0));
                        }
                    }
                    TerminalCommand::Resize(cols, rows) => {
                        pending_resize = Some((cols.max(20), rows.max(5)));
                    }
                    TerminalCommand::Wake => {}
                    TerminalCommand::Close => {
                        closed = true;
                        break;
                    }
                }
            }
            if closed {
                break;
            }
            if !retrying_input_write {
                if let Some((cols, rows)) = pending_resize {
                    match channel.request_pty_size(cols, rows, None, None) {
                        Ok(()) => pending_resize = None,
                        Err(error) if retryable_ssh_error(&error) => {}
                        Err(error) => {
                            close_message =
                                Some(format!("Terminal connection lost while resizing: {error}"));
                            closed = true;
                        }
                    }
                }
            }
            if closed {
                break;
            }
            while let Some((data, offset)) = pending_input.front_mut() {
                match channel.write(&data[*offset..]) {
                    Ok(size) if size > 0 => {
                        retrying_input_write = false;
                        progress = true;
                        *offset += size;
                        pending_input_bytes.fetch_sub(size, Ordering::Relaxed);
                        if *offset == data.len() {
                            pending_input.pop_front();
                        }
                    }
                    Ok(_) => {
                        retrying_input_write = true;
                        break;
                    }
                    Err(error) if retryable_io_error(&error) => {
                        retrying_input_write = true;
                        break;
                    }
                    Err(error) => {
                        close_message = Some(format!(
                            "Terminal connection lost while sending input: {error}"
                        ));
                        closed = true;
                        break;
                    }
                }
            }
            if closed {
                break;
            }
            // Drain everything libssh2 has buffered, up to the flow-control limits.
            let mut drained = false;
            while pump.wants_input() {
                match channel.read(&mut buffer) {
                    Ok(size) if size > 0 => {
                        pump.push(&buffer[..size]);
                        progress = true;
                    }
                    Ok(_) => {
                        drained = true;
                        break;
                    }
                    Err(error) if retryable_io_error(&error) => {
                        drained = true;
                        break;
                    }
                    Err(error) => {
                        close_message = Some(format!(
                            "Terminal connection lost while reading output: {error}"
                        ));
                        closed = true;
                        break;
                    }
                }
            }
            let flush_wait = pump.flush_if_due();
            if Instant::now() >= next_keepalive {
                match client.session_mut().keepalive_send() {
                    Ok(seconds) => {
                        keepalive_failures = 0;
                        next_keepalive =
                            Instant::now() + Duration::from_secs(u64::from(seconds.max(1)));
                    }
                    Err(error) if error.code() == ErrorCode::Session(-37) => {
                        next_keepalive = Instant::now() + Duration::from_millis(250);
                    }
                    Err(error) => {
                        keepalive_failures += 1;
                        if keepalive_failures >= MAX_KEEPALIVE_FAILURES {
                            close_message = Some(format!("SSH connection lost: {error}"));
                            closed = true;
                        } else {
                            next_keepalive = Instant::now() + KEEPALIVE_RETRY_DELAY;
                        }
                    }
                }
            }
            // Output can still be buffered in libssh2 after EOF; only stop once drained.
            if drained && channel.eof() {
                closed = true;
            }
            if closed {
                break;
            }
            if progress && !retrying_input_write {
                idle_wait = MIN_POLL_INTERVAL;
                continue;
            }
            let wait = flush_wait.map_or(idle_wait, |due| due.min(idle_wait));
            match receiver.recv_timeout(wait) {
                Ok(command) => {
                    next_command = Some(command);
                    idle_wait = MIN_POLL_INTERVAL;
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    idle_wait = (idle_wait * 2).min(MAX_POLL_INTERVAL);
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => closed = true,
            }
        }
        let exit_status = command.as_ref().and_then(|_| channel.exit_status().ok());
        let _ = channel.close();
        let _ = channel.wait_close();
        let _ = thread_sessions
            .lock()
            .map(|mut sessions| sessions.remove(&thread_session_id));
        pump.close(&close_message.unwrap_or_else(|| match exit_status {
            Some(0) => "Remote command finished".to_string(),
            Some(status) => format!("Remote command exited with status {status}"),
            None => "Remote shell exited".to_string(),
        }));
    });
    Ok(TerminalStarted {
        session_id,
        server_id: profile.id,
    })
}

/// Adds a session started by another backend (such as a local PTY) to the session map.
pub(crate) fn register(
    sessions: &TerminalSessions,
    session_id: &str,
    server_id: &str,
    sender: mpsc::Sender<TerminalCommand>,
    pending_input_bytes: Arc<AtomicUsize>,
    unacked: Unacked,
) -> Result<(), String> {
    sessions
        .lock()
        .map_err(|_| "Terminal session lock was poisoned".to_string())?
        .insert(
            session_id.to_string(),
            TerminalSession {
                server_id: server_id.to_string(),
                sender,
                pending_input_bytes,
                unacked,
            },
        );
    Ok(())
}

pub(crate) fn unregister(sessions: &TerminalSessions, session_id: &str) {
    let _ = sessions
        .lock()
        .map(|mut sessions| sessions.remove(session_id));
}

pub fn input(sessions: &TerminalSessions, session_id: &str, data: String) -> Result<(), String> {
    let session = sessions
        .lock()
        .map_err(|_| "Terminal session lock was poisoned".to_string())?
        .get(session_id)
        .cloned()
        .ok_or_else(|| "That terminal session is no longer connected".to_string())?;
    let data = data.into_bytes();
    let length = data.len();
    reserve_input_bytes(&session.pending_input_bytes, length)?;
    session
        .sender
        .send(TerminalCommand::Input(data))
        .map_err(|_| {
            session
                .pending_input_bytes
                .fetch_sub(length, Ordering::Relaxed);
            "That terminal session is no longer connected".to_string()
        })
}

pub fn resize(sessions: &TerminalSessions, request: TerminalResize) -> Result<(), String> {
    let sender = sessions
        .lock()
        .map_err(|_| "Terminal session lock was poisoned".to_string())?
        .get(&request.session_id)
        .map(|session| session.sender.clone())
        .ok_or_else(|| "That terminal session is no longer connected".to_string())?;
    sender
        .send(TerminalCommand::Resize(request.cols, request.rows))
        .map_err(|_| "That terminal session is no longer connected".to_string())
}

pub fn ack(sessions: &TerminalSessions, session_id: &str, bytes: usize) -> Result<(), String> {
    let sessions = sessions
        .lock()
        .map_err(|_| "Terminal session lock was poisoned".to_string())?;
    // Acks can race with the session closing; there is nothing left to throttle then.
    if let Some(session) = sessions.get(session_id) {
        session.unacked.ack(bytes);
        let _ = session.sender.send(TerminalCommand::Wake);
    }
    Ok(())
}

pub fn close(sessions: &TerminalSessions, session_id: &str) -> Result<(), String> {
    if let Some(sender) = sessions
        .lock()
        .map_err(|_| "Terminal session lock was poisoned".to_string())?
        .get(session_id)
        .map(|session| session.sender.clone())
    {
        let _ = sender.send(TerminalCommand::Close);
    }
    Ok(())
}

pub fn close_server(sessions: &TerminalSessions, server_id: &str) {
    let senders = sessions
        .lock()
        .map(|mut sessions| {
            let session_ids = sessions
                .iter()
                .filter(|(_, session)| session.server_id == server_id)
                .map(|(session_id, _)| session_id.clone())
                .collect::<Vec<_>>();
            session_ids
                .into_iter()
                .filter_map(|session_id| sessions.remove(&session_id))
                .map(|session| session.sender)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    for sender in senders {
        let _ = sender.send(TerminalCommand::Close);
    }
}

/// Closes every SSH session. Local shells do not depend on the credential vault and stay open.
pub fn close_remote(sessions: &TerminalSessions) {
    let senders = sessions
        .lock()
        .map(|mut sessions| {
            let session_ids = sessions
                .iter()
                .filter(|(_, session)| session.server_id != LOCAL_SERVER_ID)
                .map(|(session_id, _)| session_id.clone())
                .collect::<Vec<_>>();
            session_ids
                .into_iter()
                .filter_map(|session_id| sessions.remove(&session_id))
                .map(|session| session.sender)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    for sender in senders {
        let _ = sender.send(TerminalCommand::Close);
    }
}

fn retryable_io_error(error: &std::io::Error) -> bool {
    matches!(
        error.kind(),
        ErrorKind::WouldBlock | ErrorKind::Interrupted | ErrorKind::TimedOut
    )
}

fn retryable_ssh_error(error: &ssh2::Error) -> bool {
    matches!(
        error.code(),
        ErrorCode::Session(-37) | ErrorCode::Session(-9)
    )
}

fn reserve_input_bytes(pending: &AtomicUsize, length: usize) -> Result<(), String> {
    let mut current = pending.load(Ordering::Relaxed);
    loop {
        let Some(next) = current.checked_add(length) else {
            return Err(
                "Terminal input queue is full; wait for the remote host to catch up".to_string(),
            );
        };
        if next > MAX_PENDING_INPUT_BYTES {
            return Err(
                "Terminal input queue is full; wait for the remote host to catch up".to_string(),
            );
        }
        match pending.compare_exchange_weak(current, next, Ordering::Relaxed, Ordering::Relaxed) {
            Ok(_) => return Ok(()),
            Err(value) => current = value,
        }
    }
}
