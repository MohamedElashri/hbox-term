//! Native OpenSSH sessions. Reading/saving a reference never starts a process.
use crate::models::{
    LocalTerminalRequest, OpenSshConfig, ServerProfile, TerminalRequest, TerminalStarted,
};
use crate::pty_output::OutputChannel;
use crate::terminal::TerminalSessions;
use portable_pty::CommandBuilder;
use std::path::PathBuf;

pub(crate) fn validate_reference(reference: &OpenSshConfig) -> Result<OpenSshConfig, String> {
    let alias = reference.alias.trim();
    if alias.is_empty()
        || alias.starts_with('-')
        || alias.chars().any(|c| c.is_whitespace() || c.is_control())
    {
        return Err("Enter a single OpenSSH host alias, without options or whitespace".into());
    }
    let config_path = match reference.config_path.as_deref().map(str::trim) {
        None | Some("") => None,
        Some("none") => Some("none".to_owned()),
        Some(value) => {
            let path = if let Some(tail) = value.strip_prefix("~/") {
                dirs::home_dir()
                    .ok_or("Home directory unavailable")?
                    .join(tail)
            } else {
                PathBuf::from(value)
            };
            let path = if path.is_absolute() {
                path
            } else {
                std::env::current_dir()
                    .map_err(|e| e.to_string())?
                    .join(path)
            };
            if !path.is_file() {
                return Err(
                    "Choose an existing SSH config file, or leave it blank for OpenSSH defaults"
                        .into(),
                );
            }
            // A normal user config retains system defaults. A custom -F file excludes them.
            if dirs::home_dir().is_some_and(|home| path == home.join(".ssh/config")) {
                None
            } else {
                Some(path.to_string_lossy().into_owned())
            }
        }
    };
    Ok(OpenSshConfig {
        share_connection: reference.share_connection,
        alias: alias.to_owned(),
        config_path,
    })
}

pub(crate) fn command(
    reference: &OpenSshConfig,
    remote_command: Option<&str>,
) -> Result<CommandBuilder, String> {
    let reference = validate_reference(reference)?;
    let binary = PathBuf::from("/usr/bin/ssh");
    if !binary.is_file() {
        return Err("OpenSSH is not installed. Install openssh-client and try again".into());
    }
    let mut command = CommandBuilder::new(binary);
    if let Some(path) = reference.config_path {
        command.args(["-F", &path]);
    }
    // Never invoke a local shell or flatten arguments. RequestTTY, RemoteCommand,
    // authentication, hooks and forwarding belong to OpenSSH. Sharing overrides
    // are applied explicitly by start(), only for app-owned multiplexing.
    command.arg("--");
    command.arg(reference.alias);
    if let Some(remote) = remote_command {
        command.arg(remote);
    }
    crate::appimage::apply(&mut command);
    if let Some(home) = dirs::home_dir() {
        command.cwd(home);
    }
    Ok(command)
}

pub(crate) fn start(
    output: OutputChannel,
    sessions: TerminalSessions,
    profile: &ServerProfile,
    request: TerminalRequest,
) -> Result<TerminalStarted, String> {
    let reference = profile
        .open_ssh
        .as_ref()
        .ok_or("This OpenSSH connection has no config reference; edit it to choose an alias")?;
    let socket = crate::openssh_pool::prepare(profile, &request.session_id, &sessions)?;
    let mut command = command(reference, request.command.as_deref())?;
    if let Some(socket) = socket {
        let at = command.get_argv().iter().position(|v| v == "--").unwrap();
        let args = [
            "-oControlMaster=auto".into(),
            "-oControlPersist=300".into(),
            "-oForkAfterAuthentication=no".into(),
            "-S".into(),
            socket.into_os_string(),
        ];
        command.get_argv_mut().splice(at..at, args);
    }
    // Shell integration and remote cwd injection would override RemoteCommand or mutate the
    // server before authentication. Native sessions use the original configuration unchanged.
    let local = LocalTerminalRequest {
        session_id: request.session_id,
        cols: request.cols,
        rows: request.rows,
        cwd: None,
        command: None,
        env: Default::default(),
        shell_integration: Some("none".into()),
    };
    crate::local_pty::spawn(output, sessions, local, command, &profile.id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{AuthMethod, ServerDraft};
    use crate::storage::Store;
    use std::fs;

    fn draft(reference: &OpenSshConfig) -> ServerDraft {
        serde_json::from_value(serde_json::json!({"name":"Native test", "host":"ignored-preview", "username":"", "port":22, "authMethod":"openSsh", "openSsh":reference})).unwrap()
    }

    #[test]
    fn cancelled_start_never_launches_config_commands_or_registers_a_terminal() {
        let dir =
            std::env::temp_dir().join(format!("ternway-openssh-cancel-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let config = dir.join("config");
        let marker = dir.join("must-not-run");
        fs::write(
            &config,
            format!(
                "Host qa\n HostName 127.0.0.1\n Port 1\n ProxyCommand touch {}\n",
                marker.display()
            ),
        )
        .unwrap();
        let store = Store::open(&dir.join("db"), &dir.join("vault")).unwrap();
        let profile = store
            .save_server(&draft(&OpenSshConfig {
                share_connection: true,
                alias: "qa".into(),
                config_path: Some(config.to_string_lossy().into()),
            }))
            .unwrap();
        let operation = uuid::Uuid::new_v4().to_string();
        crate::ssh::cancel_operation(&operation).unwrap();
        let sessions: TerminalSessions = Default::default();
        let request: TerminalRequest = serde_json::from_value(serde_json::json!({"sessionId":uuid::Uuid::new_v4(),"serverId":profile.id,"cols":80,"rows":24})).unwrap();
        let output = tauri::ipc::Channel::new(|_| Ok(()));
        let error =
            crate::terminal::start(output, store, sessions.clone(), request, Some(&operation))
                .err()
                .unwrap();
        assert_eq!(error, crate::ssh::OPERATION_CANCELLED);
        assert!(sessions.lock().unwrap().is_empty());
        assert!(!marker.exists());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn arguments_preserve_config_and_alias_without_shell_or_ssh_overrides() {
        let path = std::env::temp_dir().join(format!(
            "ternway-config with spaces-{}",
            uuid::Uuid::new_v4()
        ));
        fs::write(
            &path,
            "Host qa\n ProxyJump bastion\n IdentityAgent ~/.ssh/agent.sock\n",
        )
        .unwrap();
        let reference = OpenSshConfig {
            share_connection: true,
            alias: "qa;echo${IFS}literal".into(),
            config_path: Some(path.to_string_lossy().into()),
        };
        let built = super::command(&reference, None).unwrap();
        let args: Vec<_> = built
            .get_argv()
            .iter()
            .map(|v| v.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            args,
            [
                "/usr/bin/ssh",
                "-F",
                &path.to_string_lossy(),
                "--",
                &reference.alias
            ]
        );
        let default: Vec<_> = super::command(
            &OpenSshConfig {
                share_connection: true,
                alias: "qa".into(),
                config_path: None,
            },
            None,
        )
        .unwrap()
        .get_argv()
        .iter()
        .map(|v| v.to_string_lossy().into_owned())
        .collect();
        assert_eq!(default, ["/usr/bin/ssh", "--", "qa"]);
        let ignored: Vec<_> = super::command(
            &OpenSshConfig {
                share_connection: true,
                alias: "qa".into(),
                config_path: Some("none".into()),
            },
            None,
        )
        .unwrap()
        .get_argv()
        .iter()
        .map(|v| v.to_string_lossy().into_owned())
        .collect();
        assert_eq!(ignored, ["/usr/bin/ssh", "-F", "none", "--", "qa"]);
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn invalid_aliases_and_missing_custom_files_are_rejected() {
        for alias in [
            "",
            "-oProxyCommand=bad",
            "qa extra",
            "qa\nother",
            "qa\0other",
        ] {
            assert!(validate_reference(&OpenSshConfig {
                share_connection: true,
                alias: alias.into(),
                config_path: None
            })
            .is_err());
        }
        assert!(validate_reference(&OpenSshConfig {
            share_connection: true,
            alias: "qa".into(),
            config_path: Some("relative/config".into())
        })
        .is_err());
        assert!(validate_reference(&OpenSshConfig {
            share_connection: true,
            alias: "qa".into(),
            config_path: Some("/nonexistent/ternway-config".into())
        })
        .is_err());
    }

    #[test]
    fn references_round_trip_without_vault_or_config_execution_and_cannot_be_managed_bastions() {
        let directory =
            std::env::temp_dir().join(format!("ternway-native-store-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        let config = directory.join("config");
        let marker = directory.join("never-run");
        fs::write(
            &config,
            format!(
                "Host qa\n ProxyCommand touch {}\nMatch exec \"touch {}\"\n User qa\n",
                marker.display(),
                marker.display()
            ),
        )
        .unwrap();
        let reference = OpenSshConfig {
            share_connection: true,
            alias: "qa".into(),
            config_path: Some(config.to_string_lossy().into()),
        };
        let store = Store::open(&directory.join("db"), &directory.join("vault")).unwrap();
        assert!(!crate::ssh_config::read(&config).unwrap().is_empty());
        let saved = store.save_server(&draft(&reference)).unwrap();
        assert_eq!(saved.open_ssh.as_ref(), Some(&reference));
        assert_eq!(saved.host, "qa");
        assert_eq!(
            store.list_servers().unwrap()[0].auth_method,
            AuthMethod::OpenSsh
        );
        let copy = store.duplicate_server(&saved.id).unwrap();
        assert_eq!(copy.open_ssh.as_ref(), Some(&reference));
        assert!(!marker.exists());
        assert!(!directory.join("vault").exists());
        let rejected = crate::ssh::SshClient::connect_with_cancellation(&saved, None, &store)
            .err()
            .unwrap();
        assert!(rejected.contains("Connect and authenticate in its terminal first"));
        let mut managed: ServerDraft = serde_json::from_value(serde_json::json!({"name":"Managed", "host":"127.0.0.1", "username":"qa", "port":22, "jumpHostId":saved.id})).unwrap();
        assert!(store
            .save_server(&managed)
            .unwrap_err()
            .contains("Managed bastions"));
        managed.id = Some(copy.id.clone());
        managed.jump_host_id = None;
        let converted = store.save_server(&managed).unwrap();
        assert_eq!(converted.auth_method, AuthMethod::Password);
        assert_eq!(converted.open_ssh, None);
        drop(store);
        let reopened = Store::open(&directory.join("db"), &directory.join("vault")).unwrap();
        assert_eq!(
            reopened.get_server(&saved.id).unwrap().open_ssh.as_ref(),
            Some(&reference)
        );
        reopened.delete_server(&saved.id).unwrap();
        assert!(reopened.get_server(&saved.id).is_err());
        drop(reopened);
        fs::remove_dir_all(directory).unwrap();
    }
}

#[cfg(test)]
mod loopback_openssh {
    use super::*;
    use crate::models::ServerDraft;
    use crate::ssh_test_fixture::SshFixture;
    use crate::storage::Store;
    use std::collections::HashMap;
    use std::fs;
    use std::sync::{mpsc, Arc, Mutex};
    use std::time::{Duration, Instant};
    use tauri::ipc::{Channel, InvokeResponseBody};

    struct Sessions(TerminalSessions, String);
    impl Drop for Sessions {
        fn drop(&mut self) {
            crate::terminal::close_server(&self.0, &self.1);
            crate::openssh_pool::disconnect(&self.1);
        }
    }

    fn run(
        config: &std::path::Path,
        alias: &str,
        password: Option<&str>,
        close_running: bool,
    ) -> String {
        let store = Store::open(
            &config.with_extension(format!("{alias}.db")),
            &config.with_extension("vault"),
        )
        .unwrap();
        let draft: ServerDraft = serde_json::from_value(serde_json::json!({"name":alias, "host":alias, "username":"", "port":22, "authMethod":"openSsh", "openSsh":{"alias":alias,"configPath":config}})).unwrap();
        let profile = store.save_server(&draft).unwrap();
        let sessions: TerminalSessions = Arc::new(Mutex::new(HashMap::new()));
        let _guard = Sessions(sessions.clone(), profile.id.clone());
        let (frames, received) = mpsc::channel();
        let output = Channel::new(move |body| {
            if let InvokeResponseBody::Raw(bytes) = body {
                let _ = frames.send(bytes);
            }
            Ok(())
        });
        let session_id = uuid::Uuid::new_v4().to_string();
        let request: TerminalRequest = serde_json::from_value(serde_json::json!({"sessionId":session_id,"serverId":profile.id,"cols":100,"rows":30,"shellIntegration":false})).unwrap();
        let started =
            crate::terminal::start(output, store, sessions.clone(), request, None).unwrap();
        assert_eq!(started.server_id, profile.id);
        let mut text = String::new();
        let mut sent_password = false;
        let mut closed = false;
        let mut resized = false;
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            let frame = match received
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            {
                Ok(frame) => frame,
                Err(mpsc::RecvTimeoutError::Disconnected) if closed => break,
                Err(error) => panic!("OpenSSH {alias} output timed out: {error}; output: {text}"),
            };
            if frame[0] != 0 {
                break;
            }
            text.push_str(&String::from_utf8_lossy(&frame[1..]));
            let _ = crate::terminal::ack(&sessions, &session_id, frame.len() - 1);
            if !sent_password && text.to_ascii_lowercase().contains("password:") {
                let password = password.expect("Unexpected password prompt for key fixture");
                crate::terminal::input(&sessions, &session_id, format!("{password}\n")).unwrap();
                sent_password = true;
            }
            if close_running && !resized && text.contains("fixture-ready") {
                crate::terminal::resize(
                    &sessions,
                    crate::models::TerminalResize {
                        session_id: session_id.clone(),
                        cols: 120,
                        rows: 40,
                    },
                )
                .unwrap();
                resized = true;
            }
            if close_running && !closed && text.contains("fixture-resized:120x40") {
                crate::terminal::close_server(&sessions, &profile.id);
                assert!(
                    sessions.lock().unwrap().is_empty(),
                    "OpenSSH must be registered under its remote profile, not Local"
                );
                closed = true;
            }
        }
        if close_running {
            assert!(closed);
        } else {
            assert!(
                text.contains("fixture-command:") || text.contains("fixture-ok"),
                "OpenSSH did not run the fixture command: {text}"
            );
        }
        if let Some(secret) = password {
            assert!(
                !text.contains(secret),
                "SSH password was echoed into scrollback"
            );
            assert!(sent_password);
        }
        text
    }

    #[test]
    #[ignore = "Run make test-openssh with the loopback fixture dependencies"]
    fn shared_terminal_files_commands_and_tunnels_use_one_authenticated_transport() {
        use std::io::{Read, Write};
        let fixture = SshFixture::start("publickey");
        let key = fixture.directory.join("client");
        assert!(std::process::Command::new("ssh-keygen")
            .args(["-q", "-t", "ed25519", "-N", "", "-f"])
            .arg(&key)
            .status()
            .unwrap()
            .success());
        let config = fixture.directory.join("config");
        fs::write(&config, format!("Host shared\n HostName 127.0.0.1\n Port {}\n User qa\n IdentityAgent none\n IdentitiesOnly yes\n IdentityFile {}\n StrictHostKeyChecking yes\n UserKnownHostsFile {}\n RequestTTY force\n RemoteCommand fixture-wait\n",fixture.port,key.display(),fixture.directory.join("known_hosts").display())).unwrap();
        let store = Store::open(
            &fixture.directory.join("db"),
            &fixture.directory.join("vault"),
        )
        .unwrap();
        let profile = store.save_server(&serde_json::from_value(serde_json::json!({"name":"shared", "host":"shared", "username":"", "port":22, "authMethod":"openSsh", "openSsh":{"alias":"shared","configPath":config}})).unwrap()).unwrap();
        let sessions: TerminalSessions = Arc::new(Mutex::new(HashMap::new()));
        let _guard = Sessions(sessions.clone(), profile.id.clone());
        assert!(!crate::openssh_pool::ready(&profile));
        assert!(crate::openssh_pool::slave(&profile, false, "no-login").is_err());
        let output = Channel::new(|_| Ok(()));
        let request: TerminalRequest = serde_json::from_value(serde_json::json!({"sessionId":uuid::Uuid::new_v4().to_string(),"serverId":profile.id,"cols":80,"rows":24})).unwrap();
        start(output, sessions.clone(), &profile, request).unwrap();
        let until = Instant::now() + Duration::from_secs(15);
        while !crate::openssh_pool::ready(&profile) {
            assert!(Instant::now() < until, "Authentication timed out");
            std::thread::sleep(Duration::from_millis(30));
        }
        let mut client =
            crate::ssh::SshClient::connect_with_cancellation(&profile, None, &store).unwrap();
        assert!(client
            .exec("shared-command")
            .unwrap()
            .stdout
            .contains("fixture-command:shared-command"));
        let fsys = client.sftp().unwrap();
        fsys.mkdir(std::path::Path::new("/folder"), 0o700).unwrap();
        let name = std::path::Path::new("/folder/a space\nand unicode-λ.bin");
        let bytes: Vec<u8> = (0..200_000).map(|n| (n % 251) as u8).collect();
        {
            let mut file = fsys.create(name).unwrap();
            file.write_all(&bytes).unwrap();
        }
        let mut actual = Vec::new();
        fsys.open(name).unwrap().read_to_end(&mut actual).unwrap();
        assert_eq!(actual, bytes);
        assert_eq!(fsys.stat(name).unwrap().size, Some(bytes.len() as u64));
        assert_eq!(
            fsys.readdir(std::path::Path::new("/folder")).unwrap()[0].0,
            name
        );
        let renamed = std::path::Path::new("/folder/renamed");
        fsys.rename(
            name,
            renamed,
            Some(ssh2::RenameFlags::ATOMIC | ssh2::RenameFlags::OVERWRITE),
        )
        .unwrap();
        assert!(fsys.stat(name).is_err());
        fsys.unlink(renamed).unwrap();
        fsys.rmdir(std::path::Path::new("/folder")).unwrap();
        let target = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let target_port = target.local_addr().unwrap().port();
        let echo = std::thread::spawn(move || {
            let (mut socket, _) = target.accept().unwrap();
            let mut b = [0; 4];
            socket.read_exact(&mut b).unwrap();
            socket.write_all(&b).unwrap();
        });
        let reserved = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = reserved.local_addr().unwrap().port();
        drop(reserved);
        let spec = format!("127.0.0.1:{port}:127.0.0.1:{target_port}");
        crate::openssh_pool::forward(&profile, "local", &spec, false).unwrap();
        let mut connection = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        connection
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        connection.write_all(b"ping").unwrap();
        let mut reply = [0; 4];
        connection.read_exact(&mut reply).unwrap();
        assert_eq!(&reply, b"ping");
        echo.join().unwrap();
        crate::openssh_pool::forward(&profile, "local", &spec, true).unwrap();
        assert!(std::net::TcpStream::connect(("127.0.0.1", port)).is_err());
        assert_eq!(
            fs::read_to_string(fixture.directory.join("connections.log"))
                .unwrap()
                .lines()
                .count(),
            1,
            "Slave tools must not open another TCP connection"
        );
        crate::openssh_pool::disconnect(&profile.id);
        assert!(!crate::openssh_pool::ready(&profile));
        assert!(client.exec("must-not-reconnect").is_err());
        assert_eq!(
            fs::read_to_string(fixture.directory.join("connections.log"))
                .unwrap()
                .lines()
                .count(),
            1
        );
    }

    #[test]
    #[ignore = "Run make test-openssh with the loopback fixture dependencies"]
    fn native_config_authentication_routing_hooks_and_lifecycle() {
        let jump = SshFixture::start("publickey");
        let target = SshFixture::start("publickey");
        let key = jump.directory.join("client");
        let bad = jump.directory.join("wrong-client");
        for path in [&key, &bad] {
            assert!(std::process::Command::new("ssh-keygen")
                .args(["-q", "-t", "ed25519", "-N", "", "-f"])
                .arg(path)
                .status()
                .unwrap()
                .success());
        }
        fs::copy(
            jump.directory.join("client.pub"),
            target.directory.join("client.pub"),
        )
        .unwrap();
        let known = jump.directory.join("known_hosts");
        let mut hosts = fs::read_to_string(&known).unwrap();
        hosts.push_str(&fs::read_to_string(target.directory.join("known_hosts")).unwrap());
        fs::write(&known, hosts).unwrap();
        let config = jump.directory.join("config");
        let marker = jump.directory.join("match-ran");
        let settings = format!("Host qa-jump\n HostName 127.0.0.1\n Port {}\nHost qa-target\n HostName 127.0.0.1\n Port {}\n ProxyJump qa-jump\nHost qa-proxy\n HostName 127.0.0.1\n Port {}\n ProxyCommand /usr/bin/ssh -F '{}' -W %h:%p qa-jump\nHost qa-wait\n HostName 127.0.0.1\n Port {}\n RemoteCommand fixture-wait\nHost qa-direct\n HostName 127.0.0.1\n Port {}\nMatch originalhost qa-target exec \"printf checked >> {}\"\n RemoteCommand fixture-from-match\nHost *\n User qa\n IdentityAgent none\n IdentitiesOnly yes\n IdentityFile {}\n IdentityFile {}\n PreferredAuthentications publickey\n StrictHostKeyChecking yes\n UserKnownHostsFile {}\n RequestTTY force\n RemoteCommand fixture-default\n", jump.port, target.port, target.port, config.display(), target.port, target.port, marker.display(), bad.display(), key.display(), known.display());
        fs::write(&config, &settings).unwrap();
        assert!(!crate::ssh_config::read(&config).unwrap().is_empty());
        assert!(!marker.exists(), "Discovery must not evaluate Match exec");
        let spaced = jump.directory.join("config with spaces");
        fs::write(&spaced, &settings).unwrap();
        assert!(run(&spaced, "qa-direct", None, false).contains("fixture-command:fixture-default"));
        assert!(
            run(&config, "qa-target", None, false).contains("fixture-command:fixture-from-match")
        );
        assert!(
            marker.exists(),
            "OpenSSH must evaluate Match exec at connection time"
        );
        assert!(run(&config, "qa-proxy", None, false).contains("fixture-command:fixture-default"));
        let auth = fs::read_to_string(target.directory.join("auth.log")).unwrap();
        assert!(
            auth.contains("rejected") && auth.contains("accepted"),
            "OpenSSH must try both IdentityFile entries"
        );
        run(&config, "qa-wait", None, true);
        // A linked reference must pick up changes, rather than keep a flattened snapshot.
        fs::write(
            &config,
            settings.replace("fixture-default", "fixture-after-edit"),
        )
        .unwrap();
        assert!(
            run(&config, "qa-proxy", None, false).contains("fixture-command:fixture-after-edit")
        );
        let password_server = SshFixture::start("password");
        let password_config = password_server.directory.join("config");
        fs::write(&password_config, format!("Host qa-password\n HostName 127.0.0.1\n Port {}\n User qa\n IdentityAgent none\n PreferredAuthentications password\n StrictHostKeyChecking yes\n UserKnownHostsFile {}\n RequestTTY force\n RemoteCommand fixture-check\n", password_server.port, password_server.directory.join("known_hosts").display())).unwrap();
        run(
            &password_config,
            "qa-password",
            Some(" fixture SSH password "),
            false,
        );
    }
}
