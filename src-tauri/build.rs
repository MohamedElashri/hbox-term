fn main() {
    let commit = std::env::var("GITHUB_SHA")
        .ok()
        .or_else(|| {
            std::process::Command::new("git")
                .args(["rev-parse", "HEAD"])
                .output()
                .ok()
                .filter(|out| out.status.success())
                .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string())
        })
        .unwrap_or_default();
    if !commit.is_empty() && commit.bytes().all(|c| c.is_ascii_hexdigit()) {
        println!("cargo:rustc-env=TERNWAY_BUILD_COMMIT={commit}");
    }
    println!("cargo:rerun-if-env-changed=GITHUB_SHA");
    println!("cargo:rerun-if-changed=../.git/HEAD");
    println!("cargo:rerun-if-changed=../.git/refs/heads");
    println!("cargo:rerun-if-changed=tauri.conf.json");
    tauri_build::build()
}
