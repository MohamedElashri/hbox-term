//! Bounded, cancellable subprocess I/O. Never invokes a shell.
use crate::ssh::{ExecOutput, OPERATION_CANCELLED};
use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Arc,
};
use std::time::{Duration, Instant};

pub(crate) fn run(
    mut command: Command,
    input: Option<Vec<u8>>,
    limit: usize,
    timeout: Duration,
    cancelled: Option<&Arc<AtomicBool>>,
) -> Result<ExecOutput, String> {
    crate::appimage::apply_std(&mut command);
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Could not start SSH client: {e}"))?;
    let stdin = child.stdin.take();
    std::thread::spawn(move || {
        if let Some(mut stdin) = stdin {
            if let Some(input) = input {
                let _ = stdin.write_all(&input);
            }
        }
    });
    let (send, receive) = mpsc::sync_channel(16);
    for (error, stream) in [
        (
            false,
            Box::new(child.stdout.take().unwrap()) as Box<dyn Read + Send>,
        ),
        (
            true,
            Box::new(child.stderr.take().unwrap()) as Box<dyn Read + Send>,
        ),
    ] {
        let send = send.clone();
        std::thread::spawn(move || {
            let mut stream = stream;
            let mut bytes = [0; 16384];
            loop {
                match stream.read(&mut bytes) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if send.send((error, Some(bytes[..n].to_vec()))).is_err() {
                            return;
                        }
                    }
                }
            }
            let _ = send.send((error, None));
        });
    }
    drop(send);
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut ended = 0;
    let mut activity = Instant::now();
    let result = loop {
        if cancelled.is_some_and(|v| v.load(Ordering::SeqCst)) {
            break Err(OPERATION_CANCELLED.to_owned());
        }
        if activity.elapsed() > timeout {
            break Err("SSH operation timed out".into());
        }
        match receive.recv_timeout(Duration::from_millis(25)) {
            Ok((error, Some(bytes))) => {
                activity = Instant::now();
                if stdout.len() + stderr.len() + bytes.len() > limit {
                    break Err("SSH output exceeded the operation limit".into());
                }
                if error {
                    stderr.extend(bytes);
                } else {
                    stdout.extend(bytes);
                }
            }
            Ok((_, None)) => ended += 1,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => ended = 2,
        }
        if ended >= 2 {
            match child.try_wait() {
                Ok(Some(status)) => {
                    break Ok(ExecOutput {
                        stdout: String::from_utf8_lossy(&stdout).into_owned(),
                        stderr: String::from_utf8_lossy(&stderr).into_owned(),
                        exit_code: status.code().unwrap_or(-1),
                    })
                }
                Ok(None) => {}
                Err(e) => break Err(e.to_string()),
            }
        }
    };
    if result.is_err() {
        let _ = child.kill();
        let _ = child.wait();
    }
    result
}
