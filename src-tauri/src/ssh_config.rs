// Read data only: never invoke ssh, Match exec, or ProxyCommand.
use crate::models::SshConfigEntry;
use std::{
    fs,
    path::{Path, PathBuf},
};

fn words(line: &str) -> Result<Vec<String>, String> {
    let line = line.trim_start();
    let keyword_end = line
        .find(|ch: char| ch.is_whitespace() || ch == '=' || ch == '#')
        .unwrap_or(line.len());
    if keyword_end == 0 {
        return Ok(Vec::new());
    }
    let (keyword, values) = line.split_at(keyword_end);
    let values = values.trim_start();
    let values = values.strip_prefix('=').unwrap_or(values).trim_start();
    let mut result = vec![keyword.to_owned()];
    let mut word = String::new();
    let mut quote = None;
    let mut escaped = false;
    for ch in values.chars() {
        if escaped {
            word.push(ch);
            escaped = false;
            continue;
        }
        if ch == '\\' {
            escaped = true;
            continue;
        }
        if quote == Some(ch) {
            quote = None;
            continue;
        }
        if quote.is_none() {
            if ch == '#' {
                break;
            }
            if ch == '"' || ch == '\'' {
                quote = Some(ch);
                continue;
            }
            if ch.is_whitespace() {
                if !word.is_empty() {
                    result.push(std::mem::take(&mut word));
                }
                continue;
            }
        }
        word.push(ch);
    }
    if quote.is_some() || escaped {
        return Err("Unterminated SSH config quote or escape".into());
    }
    if !word.is_empty() {
        result.push(word);
    }
    Ok(result)
}

fn matches(pattern: &str, value: &str) -> bool {
    let (p, v) = (pattern.as_bytes(), value.as_bytes());
    let (mut i, mut j, mut star, mut retry) = (0, 0, None, 0);
    while j < v.len() {
        if i < p.len() && (p[i] == b'?' || p[i].eq_ignore_ascii_case(&v[j])) {
            i += 1;
            j += 1;
        } else if i < p.len() && p[i] == b'*' {
            star = Some(i);
            i += 1;
            retry = j;
        } else if let Some(s) = star {
            retry += 1;
            j = retry;
            i = s + 1;
        } else {
            return false;
        }
    }
    while i < p.len() && p[i] == b'*' {
        i += 1;
    }
    i == p.len()
}

#[derive(Debug)]
struct Directive {
    fields: Vec<String>,
    included: Vec<Vec<Directive>>,
    issue: Option<String>,
}

fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_default()
}

fn expand_path(value: &str) -> Result<PathBuf, String> {
    let mut expanded = String::new();
    let mut remaining = value;
    while let Some(start) = remaining.find("${") {
        expanded.push_str(&remaining[..start]);
        let end = remaining[start + 2..]
            .find('}')
            .map(|i| start + 2 + i)
            .ok_or("Unclosed environment variable")?;
        let name = &remaining[start + 2..end];
        expanded.push_str(
            &std::env::var(name).map_err(|_| format!("Environment variable {name} is not set"))?,
        );
        remaining = &remaining[end + 1..];
    }
    expanded.push_str(remaining);
    let value = expanded;
    if value == "~" {
        return Ok(home());
    }
    if let Some(tail) = value.strip_prefix("~/") {
        return Ok(home().join(tail));
    }
    if value.starts_with('~') {
        return Err("Named-user home paths need manual configuration".into());
    }
    Ok(PathBuf::from(value))
}

// These Include tokens depend only on this machine, so discovery can expand them
// without evaluating a host, executing Match, or contacting the network.
fn local_include(value: &str) -> Option<String> {
    let mut expanded = String::new();
    let mut chars = value.chars();
    while let Some(ch) = chars.next() {
        if ch != '%' {
            expanded.push(ch);
            continue;
        }
        match chars.next()? {
            '%' => expanded.push('%'),
            'd' => expanded.push_str(&home().to_string_lossy()),
            'u' => expanded.push_str(&std::env::var("USER").ok()?),
            _ => return None,
        }
    }
    Some(expanded)
}

fn lines(
    path: &Path,
    base: &Path,
    depth: usize,
    count: &mut usize,
) -> Result<Vec<Directive>, String> {
    if depth > 8 {
        return Err("SSH config Include nesting exceeds eight levels".into());
    }
    let content =
        fs::read_to_string(path).map_err(|e| format!("Could not read {}: {e}", path.display()))?;
    if content.len() > 1_048_576 {
        return Err("SSH config exceeds 1 MiB".into());
    }
    let mut out = Vec::new();
    for (number, line) in content.lines().enumerate() {
        let fields =
            words(line).map_err(|error| format!("{}:{}: {error}", path.display(), number + 1))?;
        if fields.is_empty() {
            continue;
        }
        *count += 1;
        if *count > 20_000 {
            return Err("SSH config contains too many directives".into());
        }
        let mut directive = Directive {
            fields,
            included: Vec::new(),
            issue: None,
        };
        if directive.fields[0].eq_ignore_ascii_case("include") {
            for name in &directive.fields[1..] {
                let Some(name) = local_include(name) else {
                    directive.issue = Some("Include uses connection-dependent tokens; OpenSSH resolves it when connecting".into());
                    continue;
                };
                let path = expand_path(&name)?;
                let path = if path.is_absolute() {
                    path
                } else {
                    base.join(path)
                };
                let paths = glob::glob(&path.to_string_lossy())
                    .map_err(|e| format!("Invalid Include pattern: {e}"))?;
                for path in paths {
                    let path = path.map_err(|e| e.to_string())?;
                    directive
                        .included
                        .push(lines(&path, base, depth + 1, count)?);
                }
            }
        }
        out.push(directive);
    }
    Ok(out)
}

fn patterns<'a>(patterns: impl Iterator<Item = &'a str>, value: &str) -> bool {
    let mut positive = false;
    for pattern in patterns {
        if let Some(excluded) = pattern.strip_prefix('!') {
            if matches(excluded, value) {
                return false;
            }
        } else if matches(pattern, value) {
            positive = true;
        }
    }
    positive
}

fn note(entry: &mut SshConfigEntry, issue: String) {
    if !entry.issues.contains(&issue) {
        entry.issues.push(issue);
    }
}

fn match_rule(values: &[String], entry: &SshConfigEntry) -> Result<bool, String> {
    if values.len() == 1 && values[0].eq_ignore_ascii_case("all") {
        return Ok(true);
    }
    let mut active = true;
    let mut index = 0;
    while index < values.len() {
        let criterion = values[index].to_ascii_lowercase();
        let (negated, criterion) = criterion
            .strip_prefix('!')
            .map_or((false, criterion.as_str()), |v| (true, v));
        let Some(pattern) = values.get(index + 1) else {
            return Err("Match requires manual review".into());
        };
        let local_user = std::env::var("USER").unwrap_or_default();
        let target = match criterion {
            "host" => entry.host.as_deref().unwrap_or(&entry.alias),
            "originalhost" => &entry.alias,
            "user" => entry.username.as_deref().unwrap_or(&local_user),
            "localuser" => &local_user,
            _ => return Err(format!("Match {criterion} cannot be resolved during import; configure this connection manually")),
        };
        active &= patterns(pattern.split(','), target) != negated;
        index += 2;
    }
    Ok(active)
}

fn apply(
    directives: &[Directive],
    entry: &mut SshConfigEntry,
    mut active: bool,
    found: &mut bool,
    identities: &mut Vec<String>,
    first: &mut std::collections::HashSet<String>,
) {
    for directive in directives {
        let keyword = directive.fields[0].to_ascii_lowercase();
        let values = &directive.fields[1..];
        if keyword == "host" {
            active = patterns(values.iter().map(String::as_str), &entry.alias);
            if active && values.iter().any(|v| v == &entry.alias) {
                *found = true;
            }
        } else if keyword == "match" {
            match match_rule(values, entry) {
                Ok(value) => active = value,
                Err(issue) => {
                    active = false;
                    note(entry, issue);
                }
            }
        } else if active && keyword == "include" {
            if let Some(issue) = &directive.issue {
                note(entry, issue.clone());
            }
            // Included blocks inherit the caller's condition, but cannot change it on return.
            for included in &directive.included {
                apply(included, entry, active, found, identities, first);
            }
        } else if active && !values.is_empty() {
            let value = &values[0];
            if keyword == "identityfile" {
                if !identities.contains(value) {
                    identities.push(value.clone());
                }
                continue;
            }
            // ProxyJump and ProxyCommand share the first obtained value.
            let first_key = if keyword == "proxyjump" || keyword == "proxycommand" {
                "proxy"
            } else {
                &keyword
            };
            if !first.insert(first_key.to_owned()) {
                continue;
            }
            match keyword.as_str() {
                "hostname" => {
                    let mut host = String::new();
                    let mut chars = value.chars();
                    let mut valid = true;
                    while let Some(ch) = chars.next() {
                        if ch != '%' {
                            host.push(ch);
                            continue;
                        }
                        match chars.next() {
                            Some('%') => host.push('%'),
                            Some('h') => host.push_str(&entry.alias),
                            _ => {
                                valid = false;
                                break;
                            }
                        }
                    }
                    if valid {
                        entry.host = Some(host);
                    } else {
                        note(entry, "HostName contains unsupported tokens".into());
                    }
                }
                "user" => entry.username = Some(value.clone()),
                "port" => match value.parse::<u16>() {
                    Ok(port) if port > 0 => entry.port = Some(port),
                    _ => note(
                        entry,
                        "Invalid SSH port; configure this connection manually".into(),
                    ),
                },
                "proxyjump"
                | "proxycommand"
                | "identityagent"
                | "certificatefile"
                | "pkcs11provider"
                | "securitykeyprovider"
                | "remotecommand"
                    if value != "none" =>
                {
                    note(
                        entry,
                        format!("{keyword} is not imported; configure this connection manually"),
                    )
                }
                "canonicalizehostname" if value != "no" && value != "false" => note(
                    entry,
                    "Hostname canonicalization requires manual configuration".into(),
                ),
                "sessiontype" if value != "default" && value != "shell" => note(
                    entry,
                    format!("SessionType {value} is not an interactive shell"),
                ),
                "preferredauthentications" => {
                    if matches!(
                        value.split(',').next(),
                        Some("password" | "keyboard-interactive")
                    ) {
                        entry.auth_method = Some("password".into());
                    } else if value == "publickey" {
                        entry.auth_method = Some("privateKey".into());
                    } else {
                        note(
                            entry,
                            "PreferredAuthentications requires manual review".into(),
                        );
                    }
                }
                _ => {}
            }
        }
    }
}

fn identity_path(value: &str, entry: &SshConfigEntry) -> Result<String, String> {
    let local_user = std::env::var("USER").unwrap_or_default();
    let port = entry.port.unwrap_or(22).to_string();
    let home = home().to_string_lossy().into_owned();
    let mut expanded = String::new();
    let mut chars = value.chars();
    while let Some(ch) = chars.next() {
        if ch != '%' {
            expanded.push(ch);
            continue;
        }
        expanded.push_str(match chars.next() {
            Some('%') => "%",
            Some('d') => &home,
            Some('h') => entry.host.as_deref().unwrap_or(&entry.alias),
            Some('n') => &entry.alias,
            Some('p') => &port,
            Some('r') => entry.username.as_deref().unwrap_or(&local_user),
            Some('u') => &local_user,
            _ => return Err("IdentityFile uses unsupported tokens; configure it manually".into()),
        });
    }
    let path = expand_path(&expanded)?;
    Ok(if path.is_absolute() {
        path
    } else {
        PathBuf::from(home).join(path)
    }
    .to_string_lossy()
    .into_owned())
}

fn aliases(directives: &[Directive], out: &mut Vec<String>) {
    for directive in directives {
        if directive.fields[0].eq_ignore_ascii_case("host") {
            for alias in &directive.fields[1..] {
                if !alias.contains(['*', '?', '!']) && !out.contains(alias) {
                    out.push(alias.clone());
                }
            }
        }
        for included in &directive.included {
            aliases(included, out);
        }
    }
}

fn read_with_base(path: &Path, include_base: &Path) -> Result<Vec<SshConfigEntry>, String> {
    let directives = lines(path, include_base, 0, &mut 0)?;
    let mut names = Vec::new();
    aliases(&directives, &mut names);
    let mut entries = Vec::new();
    for alias in names {
        let mut entry = SshConfigEntry {
            alias,
            host: None,
            username: None,
            port: None,
            key_path: None,
            auth_method: None,
            service: None,
            issues: Vec::new(),
        };
        let mut identities = Vec::new();
        let mut found = false;
        apply(
            &directives,
            &mut entry,
            true,
            &mut found,
            &mut identities,
            &mut std::collections::HashSet::new(),
        );
        if !found {
            continue;
        }
        let keys: Vec<_> = identities.into_iter().filter(|v| v != "none").collect();
        if keys.len() > 1 {
            note(
                &mut entry,
                "Multiple IdentityFile values need manual key selection".into(),
            );
        }
        if let Some(key) = keys.first() {
            match identity_path(key, &entry) {
                Ok(path) => entry.key_path = Some(path),
                Err(issue) => note(&mut entry, issue),
            }
        }
        if entry.auth_method.as_deref() == Some("privateKey") && entry.key_path.is_none() {
            note(
                &mut entry,
                "Public-key authentication needs a key or SSH agent identity".into(),
            );
        }
        let host = entry
            .host
            .as_deref()
            .unwrap_or(&entry.alias)
            .trim_end_matches('.')
            .to_ascii_lowercase();
        if entry.username.as_deref() == Some("git")
            || [
                "github.com",
                "ssh.github.com",
                "gitlab.com",
                "altssh.gitlab.com",
                "bitbucket.org",
                "altssh.bitbucket.org",
            ]
            .contains(&host.as_str())
        {
            entry.service =
                Some("Git service — usually does not provide an interactive shell".into());
        }
        entries.push(entry);
    }
    entries.sort_by(|a, b| a.alias.cmp(&b.alias));
    Ok(entries)
}

pub fn read(path: &Path) -> Result<Vec<SshConfigEntry>, String> {
    // OpenSSH resolves relative user Includes from ~/.ssh, even with a custom -F file.
    let base = if path.starts_with("/etc/ssh") {
        PathBuf::from("/etc/ssh")
    } else {
        home().join(".ssh")
    };
    read_with_base(path, &base)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(config: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ternway-config-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("config"), config).unwrap();
        dir
    }

    #[test]
    fn include_discovery_expands_local_tokens_without_a_connection() {
        assert_eq!(
            local_include("%d/.ssh/config").unwrap(),
            format!("{}/.ssh/config", home().display())
        );
        assert_eq!(local_include("%%h").as_deref(), Some("%h"));
        assert!(local_include("%h/config").is_none());
        let dir = fixture("");
        fs::write(
            dir.join("%-extra.conf"),
            "Host local-token-host\n User qa\n",
        )
        .unwrap();
        fs::write(
            dir.join("config"),
            format!("Include {}/%%-extra.conf\n", dir.display()),
        )
        .unwrap();
        let entries = read(&dir.join("config")).unwrap();
        assert_eq!(entries[0].alias, "local-token-host");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn malformed_values_are_reported_instead_of_partially_imported() {
        assert!(words("IdentityFile \"unfinished").is_err());
        let dir = fixture("Host bad\n IdentityFile \"unfinished\n");
        let error = read(&dir.join("config")).unwrap_err();
        assert!(error.contains("config:2:"));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn recognizes_git_services_without_misclassifying_normal_shell_hosts() {
        let dir = fixture("Host work-git\n HostName github.com\n User git\nHost company-git\n HostName git.internal.example\n User git\nHost git-runner\n HostName runner.example\n User ubuntu\n");
        let entries = read(&dir.join("config")).unwrap();
        assert!(entries
            .iter()
            .find(|e| e.alias == "work-git")
            .unwrap()
            .service
            .is_some());
        assert!(entries
            .iter()
            .find(|e| e.alias == "company-git")
            .unwrap()
            .service
            .is_some());
        assert!(entries
            .iter()
            .find(|e| e.alias == "git-runner")
            .unwrap()
            .service
            .is_none());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn conditional_includes_do_not_leak_defaults_or_unreachable_aliases() {
        let dir = fixture("Host lab\n Include *.conf\n Port 239\nHost other\n User other-user\nHost *\n User fallback\n");
        fs::write(
            dir.join("a.conf"),
            "User ubuntu\nHost unreachable\n User wrong\n",
        )
        .unwrap();
        fs::write(dir.join("b.conf"), "Port 2222\n").unwrap();
        let entries = read_with_base(&dir.join("config"), &dir).unwrap();
        assert_eq!(entries.len(), 2);
        let lab = entries.iter().find(|e| e.alias == "lab").unwrap();
        assert_eq!(lab.username.as_deref(), Some("ubuntu"));
        assert_eq!(lab.port, Some(2222));
        let other = entries.iter().find(|e| e.alias == "other").unwrap();
        assert_eq!(other.username.as_deref(), Some("other-user"));
        assert_eq!(other.port, None);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn supported_match_rules_and_first_value_precedence_are_preserved() {
        let dir = fixture("Host lab\n HostName lab.example\n User ubuntu\nHost other\n User someone\nMatch originalhost lab,!other user ubuntu\n Port 239\nMatch host lab.example\n User wrong\nMatch all\n User fallback\n Port 22\n");
        let entries = read(&dir.join("config")).unwrap();
        assert_eq!(entries[0].host.as_deref(), Some("lab.example"));
        assert_eq!(entries[0].username.as_deref(), Some("ubuntu"));
        assert_eq!(entries[0].port, Some(239));
        assert_eq!(entries[1].username.as_deref(), Some("someone"));
        assert!(entries.iter().all(|e| e.issues.is_empty()));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn preserves_identity_tokens_and_flags_multiple_keys_and_unsupported_routes() {
        let dir = fixture("Host lab\n HostName lab.example\n User ubuntu\n Port 239\n IdentityFile ~/.ssh/%h-%r-%p-%%\nHost internal\n ProxyJump bastion\n IdentityFile /key/one\n IdentityFile /key/two\nHost proxied\n ProxyCommand ssh -W %h:%p bastion\nHost dynamic\nMatch exec \"touch NEVER_RUN\"\n User root\n");
        let marker = dir.join("NEVER_RUN");
        let config = fs::read_to_string(dir.join("config"))
            .unwrap()
            .replace("NEVER_RUN", &marker.to_string_lossy());
        fs::write(dir.join("config"), config).unwrap();
        let entries = read(&dir.join("config")).unwrap();
        let lab = entries.iter().find(|e| e.alias == "lab").unwrap();
        assert!(lab
            .key_path
            .as_ref()
            .unwrap()
            .ends_with("lab.example-ubuntu-239-%"));
        let internal = entries.iter().find(|e| e.alias == "internal").unwrap();
        assert!(internal.issues.iter().any(|i| i.contains("proxyjump")));
        assert!(internal.issues.iter().any(|i| i.contains("Multiple")));
        assert!(entries
            .iter()
            .find(|e| e.alias == "proxied")
            .unwrap()
            .issues
            .iter()
            .any(|i| i.contains("proxycommand")));
        assert!(entries
            .iter()
            .all(|e| e.issues.iter().any(|i| i.contains("Match exec"))));
        assert!(!dir.join("NEVER_RUN").exists());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn matches_openssh_for_static_host_defaults_and_conditional_includes() {
        let dir = fixture("");
        let included = dir.join("conditional.conf");
        fs::write(&included, "Host other\n User should-not-leak\n").unwrap();
        fs::write(dir.join("config"), format!("Host lab\n HostName lab.example\n Include {}\n Port 239\nHost other\n User other-user\nHost * !other\n User ubuntu\n Port 22\n", included.display())).unwrap();
        for entry in read(&dir.join("config")).unwrap() {
            // Only our generated fixture is passed to ssh; never evaluate the user's config.
            let output = std::process::Command::new("ssh")
                .args(["-G", "-F"])
                .arg(dir.join("config"))
                .arg(&entry.alias)
                .output()
                .expect("Install openssh-client for configuration parity tests");
            assert!(output.status.success());
            let output = String::from_utf8(output.stdout).unwrap();
            for (key, expected) in [
                ("hostname", entry.host.unwrap_or(entry.alias)),
                ("user", entry.username.unwrap()),
            ] {
                assert!(
                    output
                        .lines()
                        .any(|line| line == format!("{key} {expected}")),
                    "OpenSSH differs: {key}"
                );
            }
            assert!(output
                .lines()
                .any(|line| line == format!("port {}", entry.port.unwrap_or(22))));
        }
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn equals_only_separates_the_keyword_from_its_value() {
        for line in [
            "IdentityFile /tmp/key=work",
            "IdentityFile=/tmp/key=work",
            "IdentityFile = /tmp/key=work",
            "IdentityFile \"/tmp/key=work #1\" # comment",
        ] {
            let fields = words(line).unwrap();
            assert_eq!(fields[0], "IdentityFile");
            assert_eq!(fields.len(), 2);
            assert!(fields[1].starts_with("/tmp/key=work"));
        }
        assert!(words("  # comment").unwrap().is_empty());
    }

    #[test]
    fn imports_an_unquoted_key_path_containing_equals() {
        let dir = std::env::temp_dir().join(format!("ssh-equals-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let key = dir.join("key=work");
        fs::write(
            dir.join("config"),
            format!(
                "Host qa\n HostName=127.0.0.1\n User = ubuntu\n IdentityFile {}\n",
                key.display()
            ),
        )
        .unwrap();
        let entries = read_with_base(&dir.join("config"), &dir).unwrap();
        assert_eq!(entries[0].key_path.as_deref(), key.to_str());
        assert_eq!(entries[0].username.as_deref(), Some("ubuntu"));
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn imports_includes_defaults_quotes_and_ignores_match() {
        let dir = std::env::temp_dir().join(format!("ssh-config-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("extra.conf"),
            "Host lab other\n HostName=example.org\n IdentityFile \"~/a # key\"\n",
        )
        .unwrap();
        fs::write(dir.join("config"), "Include *.conf\nHost lab\n Port 239\nMatch exec \"never execute\"\n User wrong\nHost * !other\n User ubuntu\n Port 22\n").unwrap();
        let entries = read_with_base(&dir.join("config"), &dir).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].port, Some(239));
        assert_eq!(entries[0].username.as_deref(), Some("ubuntu"));
        assert!(entries[0].key_path.as_ref().unwrap().ends_with("a # key"));
        assert_eq!(entries[1].username, None);
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn rejects_include_cycles() {
        let dir = std::env::temp_dir().join(format!("ssh-cycle-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("config"), "Include config").unwrap();
        assert!(read_with_base(&dir.join("config"), &dir)
            .unwrap_err()
            .contains("nesting"));
        fs::remove_dir_all(dir).unwrap();
    }
}
