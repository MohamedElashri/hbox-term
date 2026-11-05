//! Test-only loopback server; no real accounts or user SSH configuration.
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::Duration;

pub(crate) struct SshFixture {
    server: Child,
    pub directory: PathBuf,
    pub port: u16,
}
impl SshFixture {
    pub fn stop(&mut self) {
        let _ = self.server.kill();
        let _ = self.server.wait();
    }

    pub fn start(mode: &str) -> Self {
        let python = std::env::var("TERNWAY_SSH_TEST_PYTHON")
            .expect("Set TERNWAY_SSH_TEST_PYTHON to the SSH fixture virtualenv's Python");
        let directory =
            std::env::temp_dir().join(format!("ternway-ssh-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let mut server = Command::new(python)
            .arg(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../tests/fixtures/ssh_password_server.py"
            ))
            .arg(mode)
            .arg(&directory)
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let stdout = server.stdout.take().unwrap();
        let mut fixture = Self {
            server,
            directory,
            port: 0,
        };
        let (ready, port_line) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut line = String::new();
            let result = BufReader::new(stdout).read_line(&mut line).map(|_| line);
            let _ = ready.send(result);
        });
        let line = port_line
            .recv_timeout(Duration::from_secs(15))
            .expect("SSH fixture startup timed out")
            .unwrap();
        fixture.port = line
            .trim()
            .parse()
            .expect("Install tests/fixtures/requirements.txt in TERNWAY_SSH_TEST_PYTHON");
        fixture
    }
}
impl Drop for SshFixture {
    fn drop(&mut self) {
        let _ = self.server.kill();
        let _ = self.server.wait();
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}
