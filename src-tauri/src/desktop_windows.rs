//! Ordinary windows, per-window session ownership and coordinated application quit.
use std::{
    collections::{BTreeSet, HashMap, HashSet, VecDeque},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};
use tauri::{
    AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};

#[derive(Default)]
pub(crate) struct DesktopWindows {
    labels: Mutex<BTreeSet<String>>,
    owners: Mutex<HashMap<String, String>>,
    log_owners: Mutex<HashMap<String, String>>,
    no_restore: Mutex<HashSet<String>>,
    quit: Mutex<Option<(String, VecDeque<String>)>>,
    pub allow_exit: AtomicBool,
}
pub(crate) fn regular(label: &str) -> bool {
    label == "main"
        || label
            .strip_prefix("workspace-")
            .is_some_and(|id| crate::layout_files::identifier(id).is_ok())
}
fn manifest(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map(|p| p.join("windows.json"))
        .map_err(|e| e.to_string())
}
fn persist(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<DesktopWindows>();
    let labels = state.labels.lock().map_err(|e| e.to_string())?;
    let excluded = state.no_restore.lock().map_err(|e| e.to_string())?;
    let saved: BTreeSet<_> = labels
        .iter()
        .filter(|label| !excluded.contains(*label))
        .cloned()
        .collect();
    crate::layout_files::private_write(
        &manifest(app)?,
        &serde_json::to_vec(&saved).map_err(|e| e.to_string())?,
    )
}
pub(crate) fn set_restore(app: &AppHandle, label: &str, enabled: bool) -> Result<(), String> {
    if !regular(label) {
        return Ok(());
    }
    {
        let state = app.state::<DesktopWindows>();
        let mut excluded = state.no_restore.lock().map_err(|e| e.to_string())?;
        if enabled {
            excluded.remove(label);
        } else {
            excluded.insert(label.into());
        }
    }
    persist(app)
}
pub(crate) fn session_path(app: &AppHandle, label: &str) -> Result<std::path::PathBuf, String> {
    if !regular(label) {
        return Err("Only regular windows have saved layouts".into());
    }
    let root = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    Ok(if label == "main" {
        root.join("session.json")
    } else {
        root.join("sessions").join(format!("{label}.json"))
    })
}
pub(crate) fn own(app: &AppHandle, label: &str, session: &str) -> Result<(), String> {
    let state = app.state::<DesktopWindows>();
    let mut owners = state.owners.lock().map_err(|e| e.to_string())?;
    {
        let terminals = app.state::<crate::AppState>().terminals.clone();
        if let Ok(active) = terminals.lock() {
            owners.retain(|id, _| active.contains_key(id));
        };
    }
    let allowed = label == "quick"
        || state
            .labels
            .lock()
            .map_err(|e| e.to_string())?
            .contains(label);
    if !allowed || app.get_webview_window(label).is_none() {
        let _ = crate::terminal::close(&app.state::<crate::AppState>().terminals, session);
        return Err(crate::ssh::OPERATION_CANCELLED.into());
    }
    owners.insert(session.into(), label.into());
    Ok(())
}
pub(crate) fn own_log(app: &AppHandle, label: &str, session: &str) -> Result<(), String> {
    let state = app.state::<DesktopWindows>();
    let mut owners = state.log_owners.lock().map_err(|e| e.to_string())?;
    let app_state = app.state::<crate::AppState>();
    {
        let active = app_state.log_streams.lock().map_err(|e| e.to_string())?;
        owners.retain(|id, _| active.contains_key(id));
    }
    if !state
        .labels
        .lock()
        .map_err(|e| e.to_string())?
        .contains(label)
        || app.get_webview_window(label).is_none()
    {
        let _ = crate::log_stream::close(&app_state.log_streams, session);
        return Err(crate::ssh::OPERATION_CANCELLED.into());
    }
    owners.insert(session.into(), label.into());
    Ok(())
}
fn take_owned(owners: &Mutex<HashMap<String, String>>, label: &str) -> Vec<String> {
    owners
        .lock()
        .map(|mut owners| {
            let ids = owners
                .iter()
                .filter(|(_, owner)| owner.as_str() == label)
                .map(|(id, _)| id.clone())
                .collect::<Vec<_>>();
            for id in &ids {
                owners.remove(id);
            }
            ids
        })
        .unwrap_or_default()
}
fn observe(app: &AppHandle, window: &WebviewWindow) {
    let app = app.clone();
    let label = window.label().to_owned();
    window.on_window_event(move |event| {
        if !matches!(event, WindowEvent::Destroyed) {
            return;
        }
        let state = app.state::<DesktopWindows>();
        if !state.allow_exit.load(Ordering::SeqCst) {
            if let Ok(mut labels) = state.labels.lock() {
                labels.remove(&label);
            }
            if let Ok(mut excluded) = state.no_restore.lock() {
                excluded.remove(&label);
            }
            let _ = persist(&app);
        }
        let app_state = app.state::<crate::AppState>();
        for id in take_owned(&state.owners, &label) {
            let _ = crate::terminal::close(&app_state.terminals, &id);
        }
        for id in take_owned(&state.log_owners, &label) {
            let _ = crate::log_stream::close(&app_state.log_streams, &id);
        }
        if state.labels.lock().is_ok_and(|labels| labels.is_empty()) {
            state.allow_exit.store(true, Ordering::SeqCst);
            app.exit(0);
        }
    });
}
fn create(app: &AppHandle, label: &str, layout: Option<&str>) -> Result<(), String> {
    let state = app.state::<DesktopWindows>();
    if state.quit.lock().map_err(|e| e.to_string())?.is_some() {
        return Err("Finish or cancel quitting before opening a window".into());
    }
    {
        let mut labels = state.labels.lock().map_err(|e| e.to_string())?;
        if labels.len() >= 128 {
            return Err("Too many windows".into());
        }
        labels.insert(label.into());
    }
    let url = match layout {
        Some(id) => format!("index.html?layout={}", crate::layout_files::identifier(id)?),
        None => "index.html".into(),
    };
    let window = match WebviewWindowBuilder::new(app, label, WebviewUrl::App(url.into()))
        .title("Ternway")
        .inner_size(1200., 780.)
        .min_inner_size(640., 480.)
        .decorations(false)
        .center()
        .visible(false)
        .build()
    {
        Ok(window) => window,
        Err(e) => {
            if let Ok(mut labels) = state.labels.lock() {
                labels.remove(label);
            }
            return Err(e.to_string());
        }
    };
    crate::fit_initial_window_to_work_area(&window);
    observe(app, &window);
    if let Err(error) = persist(app) {
        let _ = window.destroy();
        return Err(error);
    }
    window
        .show()
        .and_then(|_| window.set_focus())
        .map_err(|e| e.to_string())
}
pub(crate) fn new_window(app: &AppHandle, layout: Option<&str>) -> Result<String, String> {
    let label = format!("workspace-{}", uuid::Uuid::new_v4());
    create(app, &label, layout)?;
    Ok(label)
}
pub(crate) fn setup(app: &AppHandle) -> Result<(), String> {
    let saved = manifest(app)
        .ok()
        .and_then(|p| crate::layout_files::read(&p).ok())
        .and_then(|s| serde_json::from_str::<BTreeSet<String>>(&s).ok())
        .unwrap_or_default();
    let state = DesktopWindows::default();
    state.labels.lock().unwrap().insert("main".into());
    app.manage(state);
    if let Some(window) = app.get_webview_window("main") {
        observe(app, &window);
    }
    // Restored windows only restore metadata; the frontend never starts saved sessions.
    let quick_only = std::env::args().any(|arg| arg == crate::quick::TOGGLE_FLAG);
    if quick_only {
        if let Ok(mut labels) = app.state::<DesktopWindows>().labels.lock() {
            labels.extend(saved.into_iter().filter(|label| regular(label)));
        }
        return Ok(());
    }
    for label in saved
        .iter()
        .filter(|label| label.as_str() != "main" && regular(label))
        .take(127)
    {
        if let Err(error) = create(app, label, None) {
            eprintln!("Could not restore a Ternway window: {error}");
        }
    }
    persist(app)
}
pub(crate) fn focused(app: &AppHandle) -> Option<WebviewWindow> {
    let windows = app.webview_windows();
    windows
        .values()
        .find(|w| regular(w.label()) && w.is_focused().unwrap_or(false))
        .cloned()
        .or_else(|| app.get_webview_window("main"))
        .or_else(|| windows.into_values().find(|w| regular(w.label())))
}
pub(crate) fn request_quit(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<DesktopWindows>();
    if state.quit.lock().map_err(|e| e.to_string())?.is_some() {
        return Ok(());
    }
    let windows = app.webview_windows();
    let mut labels = windows
        .keys()
        .filter(|label| regular(label) || label.as_str() == "quick")
        .cloned()
        .collect::<Vec<_>>();
    labels.sort();
    if let Some(focused) = focused(app) {
        if let Some(index) = labels.iter().position(|label| label == focused.label()) {
            labels.swap(0, index);
        }
    }
    if labels.is_empty() {
        state.allow_exit.store(true, Ordering::SeqCst);
        app.exit(0);
        return Ok(());
    }
    let token = uuid::Uuid::new_v4().to_string();
    *state.quit.lock().map_err(|e| e.to_string())? = Some((token.clone(), labels.into()));
    emit_next_quit(app, &token)
}
fn emit_next_quit(app: &AppHandle, token: &str) -> Result<(), String> {
    let next = app
        .state::<DesktopWindows>()
        .quit
        .lock()
        .map_err(|e| e.to_string())?
        .as_ref()
        .and_then(|(current, pending)| {
            (current == token)
                .then(|| pending.front().cloned())
                .flatten()
        });
    if let Some(label) = next {
        if let Some(window) = app.get_webview_window(&label) {
            if let Err(error) = window.emit("prepare-quit", token) {
                *app.state::<DesktopWindows>()
                    .quit
                    .lock()
                    .map_err(|e| e.to_string())? = None;
                return Err(error.to_string());
            }
        } else {
            acknowledge_quit(app, &label, token, true)?;
        }
    }
    Ok(())
}
pub(crate) fn pending_quit(app: &AppHandle, label: &str) -> Option<String> {
    app.state::<DesktopWindows>()
        .quit
        .lock()
        .ok()
        .and_then(|request| {
            request.as_ref().and_then(|(token, pending)| {
                (pending.front().is_some_and(|next| next == label)).then(|| token.clone())
            })
        })
}
fn acknowledge(
    request: &mut Option<(String, VecDeque<String>)>,
    label: &str,
    token: &str,
    ready: bool,
) -> bool {
    let Some((current, pending)) = request.as_mut() else {
        return false;
    };
    if current != token || !pending.front().is_some_and(|next| next == label) {
        return false;
    }
    if !ready {
        *request = None;
        return false;
    }
    pending.pop_front();
    if pending.is_empty() {
        *request = None;
        return true;
    }
    false
}

pub(crate) fn acknowledge_quit(
    app: &AppHandle,
    label: &str,
    token: &str,
    ready: bool,
) -> Result<(), String> {
    let state = app.state::<DesktopWindows>();
    let should_exit = {
        let mut request = state.quit.lock().map_err(|e| e.to_string())?;
        if !request.as_ref().is_some_and(|(current, pending)| {
            current == token && pending.front().is_some_and(|next| next == label)
        }) {
            return Ok(());
        }
        acknowledge(&mut request, label, token, ready)
    };
    if should_exit {
        state.allow_exit.store(true, Ordering::SeqCst);
        app.exit(0);
    } else if ready {
        emit_next_quit(app, token)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn closing_a_window_takes_only_its_own_resources() {
        let owners = Mutex::new(HashMap::from([
            ("a".into(), "main".into()),
            ("b".into(), "other".into()),
            ("c".into(), "main".into()),
        ]));
        let mut removed = take_owned(&owners, "main");
        removed.sort();
        assert_eq!(removed, vec!["a", "c"]);
        assert_eq!(owners.lock().unwrap().get("b").unwrap(), "other");
        assert!(take_owned(&owners, "main").is_empty());
    }
    #[test]
    fn quit_waits_for_every_window_and_ignores_stale_or_duplicate_replies() {
        let mut request = Some((
            "current".to_string(),
            VecDeque::from(["main".to_string(), "other".to_string()]),
        ));
        assert!(!acknowledge(&mut request, "main", "previous", true));
        assert!(!acknowledge(&mut request, "unknown", "current", true));
        assert!(!acknowledge(&mut request, "other", "current", true)); // no prompt in a second window yet
        assert!(!acknowledge(&mut request, "main", "current", true));
        assert!(!acknowledge(&mut request, "main", "current", true));
        assert!(request.is_some());
        assert!(acknowledge(&mut request, "other", "current", true));
        assert!(request.is_none());
    }
    #[test]
    fn a_window_can_cancel_quit_without_closing_other_windows() {
        let mut request = Some((
            "token".to_string(),
            VecDeque::from(["main".to_string(), "other".to_string()]),
        ));
        assert!(!acknowledge(&mut request, "main", "token", false));
        assert!(request.is_none());
        assert!(!acknowledge(&mut request, "other", "token", true));
    }
    #[test]
    fn only_owned_window_labels_can_choose_session_paths() {
        assert!(regular("main"));
        assert!(regular(&format!("workspace-{}", uuid::Uuid::new_v4())));
        for label in [
            "quick",
            "workspace-../../outside",
            "../main",
            "workspace",
            "workspace-invalid",
        ] {
            assert!(!regular(label));
        }
    }
}
