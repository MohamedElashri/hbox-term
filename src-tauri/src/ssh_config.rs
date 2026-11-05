// Read data only: never invoke ssh, Match exec, or ProxyCommand.
use crate::models::SshConfigEntry;
use std::{
    fs,
    path::{Path, PathBuf},
};

fn words(line: &str) -> Vec<String> {
    let line = line.trim_start();
    let keyword_end = line
        .find(|ch: char| ch.is_whitespace() || ch == '=' || ch == '#')
        .unwrap_or(line.len());
    if keyword_end == 0 {
        return Vec::new();
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
    if !word.is_empty() {
        result.push(word);
    }
    result
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

fn expand(value: &str, base: &Path) -> PathBuf {
    if let Some(tail) = value.strip_prefix("~/") {
        dirs::home_dir().unwrap_or_default().join(tail)
    } else {
        base.join(value)
    }
}

fn lines(path: &Path, base: &Path, depth: usize, out: &mut Vec<Vec<String>>) -> Result<(), String> {
    if depth > 8 {
        return Err("SSH config Include nesting exceeds eight levels".into());
    }
    let content =
        fs::read_to_string(path).map_err(|e| format!("Could not read {}: {e}", path.display()))?;
    if content.len() > 1_048_576 {
        return Err("SSH config exceeds 1 MiB".into());
    }
    for line in content.lines() {
        let fields = words(line);
        if fields.is_empty() {
            continue;
        }
        if fields[0].eq_ignore_ascii_case("include") {
            for name in &fields[1..] {
                let path = expand(name, base);
                let mut paths = Vec::new();
                if name.contains('*') || name.contains('?') {
                    let parent = path.parent().unwrap_or(base);
                    let pattern = path.file_name().unwrap_or_default().to_string_lossy();
                    if let Ok(entries) = fs::read_dir(parent) {
                        paths.extend(
                            entries
                                .flatten()
                                .filter(|e| matches(&pattern, &e.file_name().to_string_lossy()))
                                .map(|e| e.path()),
                        );
                    }
                    paths.sort();
                } else if path.exists() {
                    paths.push(path);
                }
                for path in paths {
                    lines(&path, base, depth + 1, out)?;
                }
            }
        } else {
            out.push(fields);
        }
        if out.len() > 20_000 {
            return Err("SSH config contains too many directives".into());
        }
    }
    Ok(())
}

pub fn read(path: &Path) -> Result<Vec<SshConfigEntry>, String> {
    let mut directives = Vec::new();
    lines(
        path,
        path.parent().unwrap_or(Path::new(".")),
        0,
        &mut directives,
    )?;
    let mut aliases = Vec::new();
    for fields in &directives {
        if fields[0].eq_ignore_ascii_case("host") {
            for alias in &fields[1..] {
                if !alias.contains(['*', '?', '!']) && !aliases.contains(alias) {
                    aliases.push(alias.clone());
                }
            }
        }
    }
    let mut entries = Vec::new();
    for alias in aliases {
        let mut entry = SshConfigEntry {
            alias: alias.clone(),
            host: None,
            username: None,
            port: None,
            key_path: None,
        };
        let mut active = true;
        for fields in &directives {
            let values = &fields[1..];
            match fields[0].to_ascii_lowercase().as_str() {
                "host" => {
                    active = values
                        .iter()
                        .any(|p| !p.starts_with('!') && matches(p, &alias))
                        && !values
                            .iter()
                            .any(|p| p.strip_prefix('!').is_some_and(|p| matches(p, &alias)))
                }
                "match" => active = false,
                _ if !active || values.is_empty() => {}
                "hostname" if entry.host.is_none() => {
                    entry.host = Some(values[0].replace("%h", &alias))
                }
                "user" if entry.username.is_none() => entry.username = Some(values[0].clone()),
                "port" if entry.port.is_none() => {
                    entry.port = values[0].parse::<u16>().ok().filter(|p| *p > 0)
                }
                "identityfile" if entry.key_path.is_none() && values[0] != "none" => {
                    entry.key_path = Some(
                        expand(&values[0], &dirs::home_dir().unwrap_or_default())
                            .to_string_lossy()
                            .into_owned(),
                    )
                }
                _ => {}
            }
        }
        entries.push(entry);
    }
    entries.sort_by(|a, b| a.alias.cmp(&b.alias));
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn equals_only_separates_the_keyword_from_its_value() {
        for line in [
            "IdentityFile /tmp/key=work",
            "IdentityFile=/tmp/key=work",
            "IdentityFile = /tmp/key=work",
            "IdentityFile \"/tmp/key=work #1\" # comment",
        ] {
            let fields = words(line);
            assert_eq!(fields[0], "IdentityFile");
            assert_eq!(fields.len(), 2);
            assert!(fields[1].starts_with("/tmp/key=work"));
        }
        assert!(words("  # comment").is_empty());
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
        let entries = read(&dir.join("config")).unwrap();
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
        let entries = read(&dir.join("config")).unwrap();
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
        assert!(read(&dir.join("config")).unwrap_err().contains("nesting"));
        fs::remove_dir_all(dir).unwrap();
    }
}
