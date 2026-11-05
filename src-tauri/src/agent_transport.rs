//! Work around libssh2 1.11's agent receive loop spinning on EOF.
//! The default receive callback returns zero on a closed agent socket, but
//! agent.c's RECV_SEND_ALL only stops for negative results. Preserve its errno
//! convention and turn EOF into ECONNRESET so rejected/disconnected agents fail.
use std::ffi::c_void;

extern "C" {
    fn libssh2_session_callback_set(
        session: *mut c_void,
        kind: libc::c_int,
        callback: *mut c_void,
    ) -> *mut c_void;
}

pub fn install(session: &ssh2::Session) {
    let mut raw = session.raw();
    // SAFETY: raw is locked for this call. Callback kind 6 is LIBSSH2_CALLBACK_RECV
    // in libssh2.h; recv_checked has its exact Unix ABI and static lifetime.
    unsafe {
        libssh2_session_callback_set(
            &mut *raw as *mut _ as *mut c_void,
            6,
            recv_checked as *const () as *mut c_void,
        );
    }
}

unsafe extern "C" fn recv_checked(
    socket: libc::c_int,
    buffer: *mut c_void,
    length: usize,
    flags: libc::c_int,
    _abstract: *mut *mut c_void,
) -> isize {
    // SAFETY: libssh2 supplies a valid buffer of length bytes and socket descriptor.
    let result = unsafe { libc::recv(socket, buffer, length, flags) };
    if result == 0 && length > 0 {
        return -(libc::ECONNRESET as isize);
    }
    if result < 0 {
        let error = std::io::Error::last_os_error()
            .raw_os_error()
            .unwrap_or(libc::EIO);
        return -(if error == libc::EINTR || error == libc::ENOENT || error == libc::EWOULDBLOCK {
            libc::EAGAIN
        } else {
            error
        } as isize);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::os::fd::AsRawFd;
    use std::os::unix::net::UnixStream;
    #[test]
    fn receives_data_and_reports_closed_agent_instead_of_zero() {
        let (read, mut write) = UnixStream::pair().unwrap();
        write.write_all(b"ok").unwrap();
        let mut buffer = [0u8; 2];
        let recv = |buffer: &mut [u8]| unsafe {
            recv_checked(
                read.as_raw_fd(),
                buffer.as_mut_ptr().cast(),
                buffer.len(),
                0,
                std::ptr::null_mut(),
            )
        };
        assert_eq!(recv(&mut buffer), 2);
        assert_eq!(&buffer, b"ok");
        drop(write);
        assert_eq!(recv(&mut buffer), -(libc::ECONNRESET as isize));
    }
    #[test]
    fn failed_agent_connect_does_not_close_reused_descriptor() {
        use std::io::Read;
        let session = ssh2::Session::new().unwrap();
        let mut agent = session.agent().unwrap();
        let missing = std::path::PathBuf::from("/tmp")
            .join(format!("hbox-missing-{}", uuid::Uuid::new_v4()));
        agent.set_identity_path(&missing).unwrap();
        assert!(agent.connect().is_err());
        // Unix reuses the descriptor closed by connect failure. Agent::drop must
        // not close this new socket (the upstream code retained the stale fd).
        let (mut sender, mut receiver) = UnixStream::pair().unwrap();
        drop(agent);
        sender.write_all(b"ok").expect("unrelated socket must remain open");
        let mut bytes = [0; 2];
        receiver.read_exact(&mut bytes).unwrap();
        assert_eq!(&bytes, b"ok");
    }

    #[test]
    fn production_agent_probe_returns_when_agent_disconnects_mid_request() {
        use std::io::Read;
        use std::os::unix::net::UnixListener;
        use std::sync::mpsc;
        use std::time::Duration;
        let directory =
            std::path::PathBuf::from("/tmp").join(format!("hbox-eof-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("agent.sock");
        let listener = UnixListener::bind(&path).unwrap();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut request = [0u8; 5];
            socket.read_exact(&mut request).unwrap();
            // EOF after reading the full list-identities request, no response.
        });
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let _ = tx.send(crate::identities::probe_agent(path.to_str().unwrap()));
        });
        let result = rx
            .recv_timeout(Duration::from_secs(3))
            .expect("closed agent must not spin");
        assert!(result.unwrap_err().contains("Could not list agent keys"));
        server.join().unwrap();
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn nonblocking_reads_preserve_again_semantics() {
        let (read, _write) = UnixStream::pair().unwrap();
        read.set_nonblocking(true).unwrap();
        let mut byte = 0u8;
        let result = unsafe {
            recv_checked(
                read.as_raw_fd(),
                (&mut byte as *mut u8).cast(),
                1,
                0,
                std::ptr::null_mut(),
            )
        };
        assert_eq!(result, -(libc::EAGAIN as isize));
    }
}
