//! Backend idle enforcement remains active when webviews are suspended.
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

fn lock(app: &AppHandle) {
    app.state::<crate::AppState>().store.lock_credentials();
    let _ = app.emit("vault-locked", ());
}

pub fn install(app: &AppHandle) {
    let handle = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(5));
        let store = &handle.state::<crate::AppState>().store;
        if store.lock_if_idle() {
            let _ = handle.emit("vault-locked", ());
        }
        #[cfg(target_os = "linux")]
        if screen_locked() {
            lock(&handle);
        }
    });
    #[cfg(target_os = "macos")]
    macos::install(app.clone());
}

#[cfg(target_os = "linux")]
fn screen_locked() -> bool {
    let session = std::env::var("XDG_SESSION_ID").unwrap_or_else(|_| "self".into());
    if session.starts_with('-') || session.chars().any(char::is_control) {
        return false;
    }
    let mut command = std::process::Command::new("loginctl");
    command.args(["show-session", &session, "--property=LockedHint", "--value"]);
    crate::child_process::run(command, None, 1024, Duration::from_secs(2), None)
        .is_ok_and(|v| v.exit_code == 0 && v.stdout.trim() == "yes")
}

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use std::{ffi::c_void, sync::OnceLock};
    static APP: OnceLock<AppHandle> = OnceLock::new();
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFNotificationCenterGetDistributedCenter() -> *const c_void;
        fn CFStringCreateWithCString(
            allocator: *const c_void,
            value: *const i8,
            encoding: u32,
        ) -> *const c_void;
        fn CFNotificationCenterAddObserver(
            center: *const c_void,
            observer: *const c_void,
            callback: extern "C" fn(
                *const c_void,
                *mut c_void,
                *const c_void,
                *const c_void,
                *const c_void,
            ),
            name: *const c_void,
            object: *const c_void,
            behavior: isize,
        );
        fn CFRelease(value: *const c_void);
        fn CFRunLoopRun();
    }
    extern "C" fn locked(
        _: *const c_void,
        _: *mut c_void,
        _: *const c_void,
        _: *const c_void,
        _: *const c_void,
    ) {
        if let Some(app) = APP.get() {
            lock(app);
        }
    }
    pub fn install(app: AppHandle) {
        if APP.set(app).is_err() {
            return;
        }
        std::thread::spawn(|| unsafe {
            let name = CFStringCreateWithCString(
                std::ptr::null(),
                c"com.apple.screenIsLocked".as_ptr(),
                0x08000100,
            );
            if name.is_null() {
                return;
            }
            CFNotificationCenterAddObserver(
                CFNotificationCenterGetDistributedCenter(),
                std::ptr::null(),
                locked,
                name,
                std::ptr::null(),
                4,
            );
            CFRelease(name);
            CFRunLoopRun();
        });
    }
}
