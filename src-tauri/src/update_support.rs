use std::path::Path;

/// macOS reports an App bundle type even for an unpackaged release executable.
pub fn unsupported_reason(
    debug: bool,
    os: &str,
    has_bundle_type: bool,
    executable: Option<&Path>,
) -> &'static str {
    if debug {
        return "Development builds update with git pull and make.";
    }
    let packaged = if os == "macos" {
        executable
            .and_then(Path::parent)
            .filter(|dir| dir.file_name().is_some_and(|name| name == "MacOS"))
            .and_then(Path::parent)
            .filter(|dir| dir.file_name().is_some_and(|name| name == "Contents"))
            .and_then(Path::parent)
            .is_some_and(|dir| dir.extension().is_some_and(|ext| ext == "app"))
    } else {
        has_bundle_type
    };
    if packaged {
        ""
    } else {
        "This build was not installed from a release package. Rebuild it or use the install script."
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn development_bundles_cannot_update() {
        assert!(unsupported_reason(
            true,
            "macos",
            true,
            Some(Path::new(
                "/Applications/Ternway.app/Contents/MacOS/ternway"
            ))
        )
        .starts_with("Development builds"));
    }

    #[test]
    fn macos_requires_a_real_app_bundle_layout() {
        assert_eq!(
            unsupported_reason(
                false,
                "macos",
                true,
                Some(Path::new(
                    "/Applications/Ternway.app/Contents/MacOS/ternway"
                ))
            ),
            ""
        );
        for path in [
            "/src/target/release/ternway",
            "/src/Ternway.app/ternway",
            "/src/Contents/MacOS/ternway",
        ] {
            assert!(
                !unsupported_reason(false, "macos", true, Some(Path::new(path))).is_empty(),
                "{path}"
            );
        }
        assert!(!unsupported_reason(false, "macos", true, None).is_empty());
    }

    #[test]
    fn linux_requires_a_packaged_binary() {
        assert_eq!(unsupported_reason(false, "linux", true, None), "");
        assert!(!unsupported_reason(false, "linux", false, None).is_empty());
    }
}
