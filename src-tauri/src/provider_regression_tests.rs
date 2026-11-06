use super::*;

#[test]
#[ignore = "Run make test-managed-tools with the isolated SSH fixture dependencies"]
fn managed_tools_loopback() {
    assert!(
        std::env::var_os("TERNWAY_QA_KNOWN_HOSTS").is_some(),
        "Use the Makefile's isolated trust file"
    );
    let fixture = crate::ssh_test_fixture::SshFixture::start("features");
    let store = Store::open(
        &fixture.directory.join("state.sqlite"),
        &fixture.directory.join("vault"),
    )
    .unwrap();
    let draft = serde_json::from_value(serde_json::json!({"name":"Disposable tools", "host":"127.0.0.1", "port":fixture.port, "username":"qa", "authMethod":"password"})).unwrap();
    let profile = store.save_server(&draft).unwrap();
    let error = connect(&store, &profile.id, None).unwrap_err();
    let crate::AppError::HostKeyUnknown { fingerprint, .. } = crate::AppError::from(error) else {
        panic!("First contact must require host-key review")
    };
    crate::ssh::accept_host_key(&store, &profile.id, "127.0.0.1", fixture.port, &fingerprint)
        .unwrap();
    store
        .set_ssh_password(&profile.id, " fixture SSH password ", false)
        .unwrap();
    connect(&store, &profile.id, None).unwrap();
    let cards = dashboard(&store, &profile.id, None).unwrap();
    let disks = cards
        .iter()
        .find_map(|card| {
            if let DashboardCard::Storage { disks } = card {
                Some(disks)
            } else {
                None
            }
        })
        .unwrap();
    assert_eq!(disks[0].mount, "/");
    assert_eq!(disks[0].percent, 25.0);
    file_action(
        &store,
        &profile.id,
        "mkdir",
        "/test-files",
        None,
        None,
        None,
    )
    .unwrap();
    write_file(
        &store,
        &profile.id,
        "/test-files/example.txt",
        "λ 漢字\n",
        None,
    )
    .unwrap();
    assert_eq!(
        read_file(&store, &profile.id, "/test-files/example.txt", None).unwrap(),
        "λ 漢字\n"
    );
    file_action(
        &store,
        &profile.id,
        "chmod",
        "/test-files/example.txt",
        None,
        Some("000".into()),
        None,
    )
    .unwrap();
    file_action(
        &store,
        &profile.id,
        "chmod",
        "/test-files/example.txt",
        None,
        Some("0644".into()),
        None,
    )
    .unwrap();
    assert_eq!(
        read_file(&store, &profile.id, "/test-files/example.txt", None).unwrap(),
        "λ 漢字\n"
    );
    file_action(
        &store,
        &profile.id,
        "rename",
        "/test-files/example.txt",
        Some("renamed.txt".into()),
        None,
        None,
    )
    .unwrap();
    file_action(
        &store,
        &profile.id,
        "delete",
        "/test-files",
        None,
        None,
        None,
    )
    .unwrap();
    assert!(!fixture.directory.join("files/test-files").exists());
    crate::ssh::disconnect_server(&profile.id).unwrap();
    assert!(!fixture.directory.join("vault").exists());
}

#[test]
fn overview_keeps_the_root_filesystem_even_after_many_temporary_mounts() {
    let mut df = "Filesystem 1024-blocks Used Available Capacity Mounted on\n".to_string();
    for index in 0..30 {
        df.push_str(&format!("tmpfs 1024 32 992 4% /run/mount-{index}\n"));
    }
    df.push_str("/dev/root 100000 25000 75000 25% /\n");
    let disks = parse_disks(&df);
    assert_eq!(disks.len(), 20);
    assert_eq!(disks[0].mount, "/");
    assert_eq!(disks[0].used_bytes, 25_000 * 1024);
}

#[test]
fn malformed_remote_disk_numbers_do_not_panic_or_hide_valid_rows() {
    let disks = parse_disks("Filesystem Blocks Used Available Use% Mounted on\n/dev/bad 18446744073709551615 1 1 1% /bad\n/dev/root 100 25 75 25% /\n/dev/data 100 20 80 20% /data with spaces\n");
    assert_eq!(disks.len(), 2);
    assert_eq!(disks[1].mount, "/data with spaces");
}

#[test]
fn exhausted_memory_does_not_replace_an_explicit_zero_available_with_cache() {
    let memory =
        parse_memory("MemTotal: 1024 kB\nMemAvailable: 0 kB\nMemFree: 10 kB\nCached: 100 kB\n");
    assert_eq!(memory.free_bytes, 0);
    assert_eq!(memory.percent, 100.0);
    assert_eq!(
        parse_memory("MemTotal: 1024 kB\nMemFree: 10 kB\nCached: 100 kB\n").free_bytes,
        110 * 1024
    );
}

#[test]
fn remote_memory_overflow_is_bounded() {
    let value = "MemTotal: 18446744073709551615 kB\nSwapTotal: 18446744073709551615 kB\n";
    assert_eq!(parse_memory(value).total_bytes, 0);
    assert_eq!(parse_swap(value).total_bytes, 0);
}

#[test]
fn file_permissions_accept_zero_without_accepting_invalid_mode_bits() {
    assert_eq!(permission_mode("000"), Ok(0));
    assert_eq!(permission_mode("0644"), Ok(0o644));
    assert_eq!(permission_mode("755"), Ok(0o755));
    for value in ["", "888", "10000", "-1", "+644"] {
        assert!(permission_mode(value).is_err());
    }
}

#[test]
fn socket_rows_require_both_endpoints_and_keep_ipv6_process_details() {
    let ports = parse_ss_ports("tcp LISTEN 0 128 [::]:239 [::]:* users:((\"sshd\",pid=123,fd=3))\ntcp LISTEN 0 128 127.0.0.1:22\n");
    assert_eq!(ports.len(), 1);
    assert_eq!(ports[0].local_address, "[::]:239");
    assert_eq!(ports[0].remote_address, "[::]:*");
    assert_eq!(ports[0].pid, Some(123));
}

#[test]
fn cron_preserves_shell_whitespace_and_includes_shorthand_jobs() {
    let jobs = parse_user_crontab("MAILTO = \"one two three four five six\"\n@reboot /opt/start --label 'two  spaces'\n0 1 * * * printf 'a  b'   >> '/tmp/a  b'\n", "qa");
    assert_eq!(jobs.len(), 2);
    assert_eq!(jobs[0].schedule, "@reboot");
    assert_eq!(jobs[0].command, "/opt/start --label 'two  spaces'");
    assert_eq!(jobs[1].command, "printf 'a  b'   >> '/tmp/a  b'");
}

#[test]
fn cron_uses_linux_sunday_numbering() {
    assert!(validate_cron("0 0 * * 0").is_ok());
    assert!(validate_cron("0 0 * * 7").is_ok());
    assert!(validate_cron("@daily").is_ok());
    let next = chrono::DateTime::parse_from_rfc3339(&next_cron_run("0 0 * * 1").unwrap()).unwrap();
    use chrono::Datelike;
    assert_eq!(next.weekday(), chrono::Weekday::Mon);
}
