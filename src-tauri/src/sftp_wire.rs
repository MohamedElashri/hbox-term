//! Bounded SFTP v3 over an already authenticated OpenSSH subsystem channel.
//! SSH authentication, encryption and host trust remain entirely in OpenSSH.
use crate::{models::ServerProfile, remote_fs::FsError};
use ssh2::{ErrorCode, FileStat, RenameFlags};
use std::{
    collections::VecDeque,
    ffi::OsString,
    io::{Read, Write},
    os::unix::ffi::{OsStrExt, OsStringExt},
    path::{Path, PathBuf},
    process::{Child, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    time::{Duration, Instant},
};
const MAX_PACKET: usize = 1_048_576;
const BLOCK: usize = 32_768;
fn u32_bytes(v: u32, b: &mut Vec<u8>) {
    b.extend(v.to_be_bytes());
}
fn blob(v: &[u8], b: &mut Vec<u8>) {
    u32_bytes(v.len() as u32, b);
    b.extend(v);
}
fn path(p: &Path, b: &mut Vec<u8>) -> Result<(), FsError> {
    let p = p.as_os_str().as_bytes();
    if p.contains(&0) || p.len() > 32768 {
        return Err(FsError::protocol("Invalid or oversized remote path"));
    }
    blob(p, b);
    Ok(())
}
fn read_packet(reader: &mut impl Read) -> Result<Vec<u8>, String> {
    let mut size = [0; 4];
    reader.read_exact(&mut size).map_err(|e| e.to_string())?;
    let size = u32::from_be_bytes(size) as usize;
    if size == 0 || size > MAX_PACKET {
        return Err("Invalid SFTP packet length".into());
    }
    let mut bytes = vec![0; size];
    reader.read_exact(&mut bytes).map_err(|e| e.to_string())?;
    Ok(bytes)
}
struct Cursor<'a> {
    data: &'a [u8],
}
impl<'a> Cursor<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], FsError> {
        if n > self.data.len() {
            return Err(FsError::protocol("Truncated SFTP packet"));
        }
        let (a, b) = self.data.split_at(n);
        self.data = b;
        Ok(a)
    }
    fn byte(&mut self) -> Result<u8, FsError> {
        Ok(self.take(1)?[0])
    }
    fn u32(&mut self) -> Result<u32, FsError> {
        Ok(u32::from_be_bytes(self.take(4)?.try_into().unwrap()))
    }
    fn u64(&mut self) -> Result<u64, FsError> {
        Ok(u64::from_be_bytes(self.take(8)?.try_into().unwrap()))
    }
    fn blob(&mut self) -> Result<&'a [u8], FsError> {
        let n = self.u32()? as usize;
        self.take(n)
    }
    fn done(&self) -> Result<(), FsError> {
        if self.data.is_empty() {
            Ok(())
        } else {
            Err(FsError::protocol("Unexpected SFTP packet data"))
        }
    }
}
fn attrs(c: &mut Cursor<'_>) -> Result<FileStat, FsError> {
    let flags = c.u32()?;
    if flags & !0x8000000f != 0 {
        return Err(FsError::protocol("Unsupported SFTP attributes"));
    }
    let size = if flags & 1 != 0 { Some(c.u64()?) } else { None };
    let (uid, gid) = if flags & 2 != 0 {
        (Some(c.u32()?), Some(c.u32()?))
    } else {
        (None, None)
    };
    let perm = if flags & 4 != 0 { Some(c.u32()?) } else { None };
    let (atime, mtime) = if flags & 8 != 0 {
        (Some(c.u32()? as u64), Some(c.u32()? as u64))
    } else {
        (None, None)
    };
    if flags & 0x80000000 != 0 {
        let n = c.u32()?;
        if n > 256 {
            return Err(FsError::protocol("Too many SFTP attribute extensions"));
        }
        for _ in 0..n {
            c.blob()?;
            c.blob()?;
        }
    }
    Ok(FileStat {
        size,
        uid,
        gid,
        perm,
        atime,
        mtime,
    })
}
fn encode_attrs(a: &FileStat, b: &mut Vec<u8>) -> Result<(), FsError> {
    if a.uid.is_some() != a.gid.is_some() || a.atime.is_some() != a.mtime.is_some() {
        return Err(FsError::protocol(
            "SFTP ownership and timestamps require paired values",
        ));
    }
    let flags = u32::from(a.size.is_some())
        | if a.uid.is_some() { 2 } else { 0 }
        | if a.perm.is_some() { 4 } else { 0 }
        | if a.atime.is_some() { 8 } else { 0 };
    u32_bytes(flags, b);
    if let Some(v) = a.size {
        b.extend(v.to_be_bytes());
    }
    if let Some(v) = a.uid {
        u32_bytes(v, b);
        u32_bytes(a.gid.unwrap(), b);
    }
    if let Some(v) = a.perm {
        u32_bytes(v, b);
    }
    if let Some(v) = a.atime {
        u32_bytes(
            u32::try_from(v)
                .map_err(|_| FsError::protocol("SFTP v3 timestamp exceeds its range"))?,
            b,
        );
        u32_bytes(
            u32::try_from(a.mtime.unwrap())
                .map_err(|_| FsError::protocol("SFTP v3 timestamp exceeds its range"))?,
            b,
        );
    }
    Ok(())
}
struct WriteRequest {
    data: Vec<u8>,
    ack: mpsc::Sender<Result<(), String>>,
}
struct Io {
    input: mpsc::SyncSender<WriteRequest>,
    output: mpsc::Receiver<Result<Vec<u8>, String>>,
    next: u32,
}
pub(crate) struct Client {
    io: Mutex<Io>,
    child: Mutex<Child>,
    failed: AtomicBool,
    cancelled: Option<Arc<AtomicBool>>,
    posix: AtomicBool,
}
impl Drop for Client {
    fn drop(&mut self) {
        if let Ok(child) = self.child.get_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}
impl Client {
    pub fn open_session(
        profile: &ServerProfile,
        cancelled: Option<Arc<AtomicBool>>,
    ) -> Result<Arc<Self>, FsError> {
        let mut command =
            crate::openssh_pool::slave(profile, true, "sftp").map_err(FsError::protocol)?;
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()?;
        let mut stdin = child.stdin.take().unwrap();
        let mut stdout = child.stdout.take().unwrap();
        let (tx, rx) = mpsc::sync_channel::<WriteRequest>(1);
        let (out, received) = mpsc::sync_channel(2);
        std::thread::spawn(move || {
            for request in rx {
                let result = stdin
                    .write_all(&request.data)
                    .and_then(|()| stdin.flush())
                    .map_err(|e| e.to_string());
                let failed = result.is_err();
                let _ = request.ack.send(result);
                if failed {
                    break;
                }
            }
        });
        std::thread::spawn(move || loop {
            let packet = read_packet(&mut stdout);
            let failed = packet.is_err();
            if out.send(packet).is_err() || failed {
                break;
            }
        });
        let client = Arc::new(Self {
            io: Mutex::new(Io {
                input: tx,
                output: received,
                next: 0,
            }),
            child: Mutex::new(child),
            failed: AtomicBool::new(false),
            cancelled,
            posix: AtomicBool::new(false),
        });
        let result = (|| {
            let io = client
                .io
                .lock()
                .map_err(|_| FsError::protocol("SFTP lock unavailable"))?;
            let packet = client.exchange(&io, vec![1, 0, 0, 0, 3], Duration::from_secs(15))?;
            let mut c = Cursor { data: &packet };
            if c.byte()? != 2 || c.u32()? != 3 {
                return Err(FsError::protocol("The server did not negotiate SFTP v3"));
            }
            while !c.data.is_empty() {
                let name = c.blob()?;
                let version = c.blob()?;
                if name == b"posix-rename@openssh.com" && version == b"1" {
                    client.posix.store(true, Ordering::Relaxed);
                }
            }
            Ok(())
        })();
        result?;
        Ok(client)
    }
    fn fail(&self, message: impl Into<String>) -> FsError {
        self.failed.store(true, Ordering::SeqCst);
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
        }
        FsError::protocol(message)
    }
    fn wait<T>(&self, receiver: &mpsc::Receiver<T>, deadline: Instant) -> Result<T, FsError> {
        loop {
            if self
                .cancelled
                .as_ref()
                .is_some_and(|v| v.load(Ordering::SeqCst))
            {
                return Err(self.fail(crate::ssh::OPERATION_CANCELLED));
            }
            if Instant::now() >= deadline {
                return Err(self.fail("SFTP operation timed out"));
            }
            match receiver.recv_timeout(Duration::from_millis(25)) {
                Ok(v) => return Ok(v),
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(_) => return Err(self.fail("SFTP subsystem disconnected")),
            }
        }
    }
    fn exchange(&self, io: &Io, packet: Vec<u8>, timeout: Duration) -> Result<Vec<u8>, FsError> {
        if self.failed.load(Ordering::SeqCst) {
            return Err(FsError::protocol("SFTP subsystem is closed"));
        }
        if packet.len() > MAX_PACKET {
            return Err(FsError::protocol("SFTP request exceeds its size limit"));
        }
        let mut data = Vec::with_capacity(packet.len() + 4);
        u32_bytes(packet.len() as u32, &mut data);
        data.extend(packet);
        let (tx, rx) = mpsc::channel();
        io.input
            .send(WriteRequest { data, ack: tx })
            .map_err(|_| self.fail("SFTP input closed"))?;
        let deadline = Instant::now() + timeout;
        self.wait(&rx, deadline)?.map_err(|e| self.fail(e))?;
        self.wait(&io.output, deadline)?.map_err(|e| self.fail(e))
    }
    fn request(&self, kind: u8, body: Vec<u8>, expected: u8) -> Result<Vec<u8>, FsError> {
        self.request_timeout(kind, body, expected, Duration::from_secs(35))
    }
    fn request_timeout(
        &self,
        kind: u8,
        body: Vec<u8>,
        expected: u8,
        timeout: Duration,
    ) -> Result<Vec<u8>, FsError> {
        let mut io = self
            .io
            .lock()
            .map_err(|_| FsError::protocol("SFTP lock unavailable"))?;
        io.next = io.next.wrapping_add(1);
        let id = io.next;
        let mut packet = vec![kind];
        u32_bytes(id, &mut packet);
        packet.extend(body);
        let result = self.exchange(&io, packet, timeout)?;
        let mut c = Cursor { data: &result };
        let response = c.byte()?;
        if c.u32()? != id {
            return Err(self.fail("SFTP response ID mismatch"));
        }
        if response == 101 {
            let status = c.u32()?;
            let message = String::from_utf8_lossy(c.blob()?).into_owned();
            c.blob()?;
            c.done()?;
            if status != 0 {
                return Err(FsError {
                    code: ErrorCode::SFTP(status as i32),
                    message: if message.is_empty() {
                        format!("SFTP status {status}")
                    } else {
                        message
                    },
                });
            }
            if expected != 101 {
                return Err(self.fail("Unexpected SFTP success response"));
            }
            return Ok(Vec::new());
        }
        if response != expected {
            return Err(self.fail("Unexpected SFTP response type"));
        }
        Ok(c.data.to_vec())
    }
    fn handle(self: &Arc<Self>, kind: u8, p: &Path, write: bool) -> Result<Vec<u8>, FsError> {
        let mut body = Vec::new();
        path(p, &mut body)?;
        if kind == 3 {
            u32_bytes(if write { 2 | 8 | 16 } else { 1 }, &mut body);
            u32_bytes(0, &mut body);
        }
        let response = self.request(kind, body, 102)?;
        let mut c = Cursor { data: &response };
        let handle = c.blob()?.to_vec();
        if handle.len() > 256 {
            return Err(self.fail("Oversized SFTP handle"));
        }
        c.done()?;
        Ok(handle)
    }
    pub fn open(self: &Arc<Self>, p: &Path, write: bool) -> Result<File, FsError> {
        Ok(File {
            client: self.clone(),
            handle: self.handle(3, p, write)?,
            offset: 0,
        })
    }
    pub fn opendir(self: &Arc<Self>, p: &Path) -> Result<Directory, FsError> {
        Ok(Directory {
            client: self.clone(),
            handle: self.handle(11, p, false)?,
            entries: VecDeque::new(),
            done: false,
        })
    }
    fn close_handle(&self, handle: &[u8]) {
        if self.failed.load(Ordering::Relaxed)
            || self
                .cancelled
                .as_ref()
                .is_some_and(|v| v.load(Ordering::Relaxed))
        {
            return;
        }
        let mut body = Vec::new();
        blob(handle, &mut body);
        let _ = self.request_timeout(4, body, 101, Duration::from_millis(500));
    }
    pub fn stat(&self, p: &Path, link: bool) -> Result<FileStat, FsError> {
        let mut body = Vec::new();
        path(p, &mut body)?;
        let response = self.request(if link { 7 } else { 17 }, body, 105)?;
        let mut c = Cursor { data: &response };
        let result = attrs(&mut c)?;
        c.done()?;
        Ok(result)
    }
    pub fn setstat(&self, p: &Path, a: &FileStat) -> Result<(), FsError> {
        let mut b = Vec::new();
        path(p, &mut b)?;
        encode_attrs(a, &mut b)?;
        self.request(9, b, 101).map(|_| ())
    }
    pub fn mkdir(&self, p: &Path, mode: u32) -> Result<(), FsError> {
        let mut b = Vec::new();
        path(p, &mut b)?;
        u32_bytes(4, &mut b);
        u32_bytes(mode, &mut b);
        self.request(14, b, 101).map(|_| ())
    }
    pub fn remove(&self, p: &Path, dir: bool) -> Result<(), FsError> {
        let mut b = Vec::new();
        path(p, &mut b)?;
        self.request(if dir { 15 } else { 13 }, b, 101).map(|_| ())
    }
    pub fn realpath(&self, p: &Path) -> Result<PathBuf, FsError> {
        let mut b = Vec::new();
        path(p, &mut b)?;
        let response = self.request(16, b, 104)?;
        let mut c = Cursor { data: &response };
        if c.u32()? != 1 {
            return Err(self.fail("Invalid SFTP realpath response"));
        }
        let p = PathBuf::from(OsString::from_vec(c.blob()?.to_vec()));
        c.blob()?;
        attrs(&mut c)?;
        c.done()?;
        Ok(p)
    }
    pub fn rename(&self, p: &Path, q: &Path, flags: Option<RenameFlags>) -> Result<(), FsError> {
        let flags = flags.unwrap_or(RenameFlags::empty());
        let extended = flags.contains(RenameFlags::OVERWRITE)
            && self.posix.load(Ordering::Relaxed);
        if flags.contains(RenameFlags::ATOMIC) && !extended {
            return Err(FsError {
                code: ErrorCode::SFTP(8),
                message: "Atomic SFTP rename is not supported by this server".into(),
            });
        }
        let mut b = Vec::new();
        if extended {
            blob(b"posix-rename@openssh.com", &mut b);
        }
        path(p, &mut b)?;
        path(q, &mut b)?;
        self.request(if extended { 200 } else { 18 }, b, 101)
            .map(|_| ())
    }
}
pub(crate) struct File {
    client: Arc<Client>,
    handle: Vec<u8>,
    offset: u64,
}
impl Drop for File {
    fn drop(&mut self) {
        self.client.close_handle(&self.handle);
    }
}
impl Read for File {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        if buffer.is_empty() {
            return Ok(0);
        }
        let n = buffer.len().min(BLOCK);
        let mut b = Vec::new();
        blob(&self.handle, &mut b);
        b.extend(self.offset.to_be_bytes());
        u32_bytes(n as u32, &mut b);
        let response = match self.client.request(5, b, 103) {
            Ok(v) => v,
            Err(e) if e.code() == ErrorCode::SFTP(1) => return Ok(0),
            Err(e) => return Err(std::io::Error::other(e)),
        };
        let mut c = Cursor { data: &response };
        let data = c.blob().map_err(std::io::Error::other)?;
        if data.is_empty() || data.len() > n {
            return Err(std::io::Error::other(
                self.client.fail("Invalid SFTP read length"),
            ));
        }
        c.done().map_err(std::io::Error::other)?;
        buffer[..data.len()].copy_from_slice(data);
        self.offset = self
            .offset
            .checked_add(data.len() as u64)
            .ok_or_else(|| std::io::Error::other("SFTP offset overflow"))?;
        Ok(data.len())
    }
}
impl Write for File {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        if buffer.is_empty() {
            return Ok(0);
        }
        let n = buffer.len().min(BLOCK);
        let mut b = Vec::new();
        blob(&self.handle, &mut b);
        b.extend(self.offset.to_be_bytes());
        blob(&buffer[..n], &mut b);
        self.client
            .request(6, b, 101)
            .map_err(std::io::Error::other)?;
        self.offset = self
            .offset
            .checked_add(n as u64)
            .ok_or_else(|| std::io::Error::other("SFTP offset overflow"))?;
        Ok(n)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
pub(crate) struct Directory {
    client: Arc<Client>,
    handle: Vec<u8>,
    entries: VecDeque<(PathBuf, FileStat)>,
    done: bool,
}
impl Drop for Directory {
    fn drop(&mut self) {
        self.client.close_handle(&self.handle);
    }
}
impl Directory {
    pub fn read(&mut self) -> Result<(PathBuf, FileStat), FsError> {
        if let Some(e) = self.entries.pop_front() {
            return Ok(e);
        }
        if self.done {
            return Err(FsError::eof());
        }
        let mut b = Vec::new();
        blob(&self.handle, &mut b);
        let response = match self.client.request(12, b, 104) {
            Ok(v) => v,
            Err(e) if e.code() == ErrorCode::SFTP(1) => {
                self.done = true;
                return Err(FsError::eof());
            }
            Err(e) => return Err(e),
        };
        let mut c = Cursor { data: &response };
        let count = c.u32()?;
        if count == 0 || count > 32768 {
            return Err(self.client.fail("Invalid SFTP directory entry count"));
        }
        for _ in 0..count {
            let name = PathBuf::from(OsString::from_vec(c.blob()?.to_vec()));
            if name.is_absolute()
                || (name != Path::new(".")
                    && name != Path::new("..")
                    && name.components().count() != 1)
                || name.as_os_str().as_bytes().contains(&0)
            {
                return Err(self.client.fail("Invalid SFTP directory entry path"));
            }
            c.blob()?;
            let a = attrs(&mut c)?;
            self.entries.push_back((name, a));
        }
        c.done()?;
        self.entries.pop_front().ok_or_else(FsError::eof)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn packets_reject_oversized_empty_and_truncated_frames() {
        for bytes in [
            vec![0, 0, 0, 0],
            ((MAX_PACKET + 1) as u32).to_be_bytes().to_vec(),
            vec![0, 0, 0, 2, 1],
            vec![0, 0],
        ] {
            assert!(read_packet(&mut bytes.as_slice()).is_err());
        }
        assert_eq!(
            read_packet(&mut [0, 0, 0, 2, 1, 2].as_slice()).unwrap(),
            vec![1, 2]
        );
    }
    #[test]
    fn strings_and_attributes_reject_unbounded_or_truncated_values() {
        assert!(Cursor {
            data: &[255, 255, 255, 255]
        }
        .blob()
        .is_err());
        for bytes in [
            vec![0, 0, 0, 16],
            vec![0, 0, 0, 1, 0],
            vec![128, 0, 0, 0, 0, 0, 1, 1],
        ] {
            assert!(attrs(&mut Cursor { data: &bytes }).is_err());
        }
        let original = FileStat {
            size: Some(1 << 40),
            uid: Some(123),
            gid: Some(456),
            perm: Some(0o100600),
            atime: Some(10),
            mtime: Some(20),
        };
        let mut bytes = Vec::new();
        encode_attrs(&original, &mut bytes).unwrap();
        let mut cursor = Cursor { data: &bytes };
        let decoded = attrs(&mut cursor).unwrap();
        cursor.done().unwrap();
        assert_eq!(decoded.size, original.size);
        assert_eq!(decoded.perm, original.perm);
        assert_eq!(decoded.gid, original.gid);
        assert_eq!(decoded.mtime, original.mtime);
        let mut invalid = original;
        invalid.gid = None;
        assert!(encode_attrs(&invalid, &mut Vec::new()).is_err());
        invalid.gid = Some(0);
        invalid.mtime = Some(u64::MAX);
        assert!(encode_attrs(&invalid, &mut Vec::new()).is_err());
    }
    #[test]
    fn paths_keep_binary_protocol_delimiters_out_of_filename_semantics() {
        let mut bytes = Vec::new();
        path(Path::new("/a space\nλ"), &mut bytes).unwrap();
        assert_eq!(
            Cursor { data: &bytes }.blob().unwrap(),
            "/a space\nλ".as_bytes()
        );
        assert!(path(Path::new("a\0b"), &mut Vec::new()).is_err());
        assert!(path(Path::new(&"a".repeat(32769)), &mut Vec::new()).is_err());
    }
}
