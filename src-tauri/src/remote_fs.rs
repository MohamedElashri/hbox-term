//! A shared filesystem interface for libssh2 and the OpenSSH SFTP subsystem.
use ssh2::{ErrorCode, FileStat, RenameFlags};
use std::{
    fmt,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Arc,
};

#[derive(Debug)]
pub(crate) struct FsError {
    pub code: ErrorCode,
    pub message: String,
}
impl FsError {
    pub fn code(&self) -> ErrorCode {
        self.code
    }
    pub fn protocol(message: impl Into<String>) -> Self {
        Self {
            code: ErrorCode::Session(-1),
            message: message.into(),
        }
    }
    pub fn eof() -> Self {
        Self {
            code: ErrorCode::Session(-16),
            message: "End of directory".into(),
        }
    }
}
impl fmt::Display for FsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for FsError {}
impl From<ssh2::Error> for FsError {
    fn from(e: ssh2::Error) -> Self {
        Self {
            code: e.code(),
            message: e.to_string(),
        }
    }
}
impl From<std::io::Error> for FsError {
    fn from(e: std::io::Error) -> Self {
        Self::protocol(e.to_string())
    }
}

pub(crate) enum RemoteFs {
    Managed(ssh2::Sftp),
    Native(Arc<crate::sftp_wire::Client>),
}
pub(crate) enum RemoteFile {
    Managed(ssh2::File),
    Native(crate::sftp_wire::File),
}
pub(crate) enum RemoteDirectory {
    Managed(ssh2::File),
    Native(crate::sftp_wire::Directory),
}
impl RemoteFs {
    pub fn open(&self, p: &Path) -> Result<RemoteFile, FsError> {
        match self {
            Self::Managed(s) => Ok(RemoteFile::Managed(s.open(p)?)),
            Self::Native(s) => Ok(RemoteFile::Native(s.open(p, false)?)),
        }
    }
    pub fn create(&self, p: &Path) -> Result<RemoteFile, FsError> {
        match self {
            Self::Managed(s) => Ok(RemoteFile::Managed(s.create(p)?)),
            Self::Native(s) => Ok(RemoteFile::Native(s.open(p, true)?)),
        }
    }
    pub fn write_existing(&self, p: &Path) -> Result<RemoteFile, FsError> {
        match self {
            Self::Managed(s) => Ok(RemoteFile::Managed(s.open_mode(
                p,
                ssh2::OpenFlags::WRITE,
                0o600,
                ssh2::OpenType::File,
            )?)),
            Self::Native(s) => Ok(RemoteFile::Native(s.write_existing(p)?)),
        }
    }
    pub fn opendir(&self, p: &Path) -> Result<RemoteDirectory, FsError> {
        match self {
            Self::Managed(s) => Ok(RemoteDirectory::Managed(s.opendir(p)?)),
            Self::Native(s) => Ok(RemoteDirectory::Native(s.opendir(p)?)),
        }
    }
    pub fn readdir(&self, p: &Path) -> Result<Vec<(PathBuf, FileStat)>, FsError> {
        match self {
            Self::Managed(s) => Ok(s.readdir(p)?),
            Self::Native(_) => {
                let mut dir = self.opendir(p)?;
                let mut files = Vec::new();
                loop {
                    match dir.readdir() {
                        Ok((name, stat)) => {
                            if name != Path::new(".") && name != Path::new("..") {
                                files.push((p.join(name), stat));
                            }
                            if files.len() > 100_000 {
                                return Err(FsError::protocol(
                                    "Directory exceeds 100,000 entries; browse a smaller folder",
                                ));
                            }
                        }
                        Err(e) if e.code() == ErrorCode::Session(-16) => break,
                        Err(e) => return Err(e),
                    }
                }
                Ok(files)
            }
        }
    }
    pub fn stat(&self, p: &Path) -> Result<FileStat, FsError> {
        match self {
            Self::Managed(s) => Ok(s.stat(p)?),
            Self::Native(s) => s.stat(p, false),
        }
    }
    pub fn lstat(&self, p: &Path) -> Result<FileStat, FsError> {
        match self {
            Self::Managed(s) => Ok(s.lstat(p)?),
            Self::Native(s) => s.stat(p, true),
        }
    }
    pub fn setstat(&self, p: &Path, a: FileStat) -> Result<(), FsError> {
        match self {
            Self::Managed(s) => Ok(s.setstat(p, a)?),
            Self::Native(s) => s.setstat(p, &a),
        }
    }
    pub fn mkdir(&self, p: &Path, mode: i32) -> Result<(), FsError> {
        match self {
            Self::Managed(s) => Ok(s.mkdir(p, mode)?),
            Self::Native(s) => s.mkdir(p, mode as u32),
        }
    }
    pub fn rmdir(&self, p: &Path) -> Result<(), FsError> {
        match self {
            Self::Managed(s) => Ok(s.rmdir(p)?),
            Self::Native(s) => s.remove(p, true),
        }
    }
    pub fn unlink(&self, p: &Path) -> Result<(), FsError> {
        match self {
            Self::Managed(s) => Ok(s.unlink(p)?),
            Self::Native(s) => s.remove(p, false),
        }
    }
    pub fn realpath(&self, p: &Path) -> Result<PathBuf, FsError> {
        match self {
            Self::Managed(s) => Ok(s.realpath(p)?),
            Self::Native(s) => s.realpath(p),
        }
    }
    pub fn rename(&self, p: &Path, q: &Path, flags: Option<RenameFlags>) -> Result<(), FsError> {
        match self {
            Self::Managed(s) => Ok(s.rename(p, q, flags)?),
            Self::Native(s) => s.rename(p, q, flags),
        }
    }
}
impl RemoteDirectory {
    pub fn readdir(&mut self) -> Result<(PathBuf, FileStat), FsError> {
        match self {
            Self::Managed(s) => Ok(s.readdir()?),
            Self::Native(s) => s.read(),
        }
    }
}
impl RemoteFile {
    pub fn set_position(&mut self, offset: u64) -> std::io::Result<()> {
        match self {
            Self::Managed(s) => {
                use std::io::Seek;
                s.seek(std::io::SeekFrom::Start(offset))?;
            }
            Self::Native(s) => s.set_position(offset),
        }
        Ok(())
    }
}
impl Read for RemoteFile {
    fn read(&mut self, b: &mut [u8]) -> std::io::Result<usize> {
        match self {
            Self::Managed(s) => s.read(b),
            Self::Native(s) => s.read(b),
        }
    }
}
impl Write for RemoteFile {
    fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
        match self {
            Self::Managed(s) => s.write(b),
            Self::Native(s) => s.write(b),
        }
    }
    fn flush(&mut self) -> std::io::Result<()> {
        match self {
            Self::Managed(s) => s.flush(),
            Self::Native(s) => s.flush(),
        }
    }
}
