//! Ordinary windows, per-window session ownership and coordinated application quit.
use std::{
    collections::{BTreeSet, HashMap, HashSet, VecDeque},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Mutex,
    },
};
use tauri::{
    AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ShutdownIntent {
    Quit,
    Restart,
}

type ShutdownRequest = (String, VecDeque<String>, ShutdownIntent);
type ShutdownReply = (String, mpsc::Sender<Result<(), String>>);

#[derive(Default)]
pub(crate) struct DesktopWindows {
    labels: Mutex<BTreeSet<String>>,
    owners: Mutex<HashMap<String, String>>,
    log_owners: Mutex<HashMap<String, String>>,
    no_restore: Mutex<HashSet<String>>,
    quit: Mutex<Option<ShutdownRequest>>,
    quit_reply: Mutex<Option<ShutdownReply>>,
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
fn window_creation(
    quit: &Mutex<Option<ShutdownRequest>>,
) -> Result<std::sync::MutexGuard<'_, Option<ShutdownRequest>>, String> {
    let preparing = quit
        .try_lock()
        .map_err(|_| "Ternway is preparing to close; try again after cancelling".to_string())?;
    if preparing.is_some() {
        return Err("Cancel closing or restarting before opening another window".into());
    }
    Ok(preparing)
}

fn create(app: &AppHandle, label: &str, layout: Option<&str>) -> Result<(), String> {
    let state = app.state::<DesktopWindows>();
    let _creation = window_creation(&state.quit)?;
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
    request_shutdown(app, ShutdownIntent::Quit, None)
}

pub(crate) fn request_restart(
    app: &AppHandle,
) -> Result<mpsc::Receiver<Result<(), String>>, String> {
    let (send, receive) = mpsc::channel();
    request_shutdown(app, ShutdownIntent::Restart, Some(send))?;
    Ok(receive)
}
fn finish_shutdown(app: &AppHandle, intent: ShutdownIntent) {
    app.state::<DesktopWindows>()
        .allow_exit
        .store(true, Ordering::SeqCst);
    match intent {
        ShutdownIntent::Quit => app.exit(0),
        ShutdownIntent::Restart => app.request_restart(),
    }
}
fn notify_reply(app: &AppHandle, token: &str, result: Result<(), String>) {
    if let Ok(mut reply) = app.state::<DesktopWindows>().quit_reply.lock() {
        if reply.as_ref().is_some_and(|(current, _)| current == token) {
            if let Some((_, send)) = reply.take() {
                let _ = send.send(result);
            }
        }
    }
}
fn request_shutdown(
    app: &AppHandle,
    intent: ShutdownIntent,
    reply: Option<mpsc::Sender<Result<(), String>>>,
) -> Result<(), String> {
    let state = app.state::<DesktopWindows>();
    let mut request = state
        .quit
        .try_lock()
        .map_err(|_| "Ternway is already preparing to close".to_string())?;
    if request.is_some() {
        return if intent == ShutdownIntent::Quit {
            Ok(())
        } else {
            Err("Ternway is already preparing to close; finish or cancel that request first".into())
        };
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
        if let Some(reply) = reply {
            let _ = reply.send(Ok(()));
        }
        drop(request);
        finish_shutdown(app, intent);
        return Ok(());
    }
    let token = uuid::Uuid::new_v4().to_string();
    if let Some(reply) = reply {
        *state.quit_reply.lock().map_err(|e| e.to_string())? = Some((token.clone(), reply));
    }
    *request = Some((token.clone(), labels.into(), intent));
    drop(request);
    let handle = app.clone();
    let deadline_token = token.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(120));
        let state = handle.state::<DesktopWindows>();
        if let Ok(mut request) = state.quit.lock() {
            if request
                .as_ref()
                .is_some_and(|(token, _, _)| token == &deadline_token)
            {
                *request = None;
                drop(request);
                notify_reply(
                    &handle,
                    &deadline_token,
                    Err(
                        "A window did not finish saving; restart was cancelled without closing it"
                            .into(),
                    ),
                );
                let _=handle.emit("shutdown-aborted",serde_json::json!({"token":deadline_token,"message":"A window did not finish saving. Close or restart was cancelled."}));
            }
        };
    });
    if let Err(error) = emit_next_quit(app, &token) {
        notify_reply(app, &token, Err(error.clone()));
        return Err(error);
    }
    Ok(())
}

fn emit_next_quit(app: &AppHandle, token: &str) -> Result<(), String> {
    let next = app
        .state::<DesktopWindows>()
        .quit
        .lock()
        .map_err(|e| e.to_string())?
        .as_ref()
        .and_then(|(current, pending, intent)| {
            (current == token)
                .then(|| pending.front().cloned().map(|label| (label, *intent)))
                .flatten()
        });
    if let Some((label, intent)) = next {
        if let Some(window) = app.get_webview_window(&label) {
            let _ = window.show();
            let _ = window.unminimize();
            let _ = window.set_focus();
            if let Err(error) = window.emit_to(
                window.label(),
                "prepare-quit",
                serde_json::json!({"token":token,"windowLabel":label,"restart":intent==ShutdownIntent::Restart}),
            ) {
                *app.state::<DesktopWindows>()
                    .quit
                    .lock()
                    .map_err(|e| e.to_string())? = None;
                notify_reply(app, token, Err(error.to_string()));
                let _=app.emit("shutdown-aborted",serde_json::json!({"token":token,"message":"A window could not prepare to close. No restart was performed."}));
                return Err(error.to_string());
            }
        } else {
            acknowledge_quit(app, &label, token, true)?;
        }
    }
    Ok(())
}
pub(crate) fn pending_quit(app: &AppHandle, label: &str) -> Option<serde_json::Value> {
    app.state::<DesktopWindows>()
        .quit
        .try_lock()
        .ok()
        .and_then(|request| {
            request.as_ref().and_then(|(token, pending, intent)| {
                (pending.front().is_some_and(|next| next == label)).then(|| serde_json::json!({"token":token,"restart":intent==&ShutdownIntent::Restart}))
            })
        })
}
fn acknowledge(
    request: &mut Option<ShutdownRequest>,
    label: &str,
    token: &str,
    ready: bool,
) -> Option<ShutdownIntent> {
    let (current, pending, intent) = request.as_mut()?;
    if current != token || !pending.front().is_some_and(|next| next == label) {
        return None;
    }
    if !ready {
        *request = None;
        return None;
    }
    pending.pop_front();
    if pending.is_empty() {
        let intent = *intent;
        *request = None;
        return Some(intent);
    }
    None
}

pub(crate) fn acknowledge_quit(
    app: &AppHandle,
    label: &str,
    token: &str,
    ready: bool,
) -> Result<(), String> {
    let state = app.state::<DesktopWindows>();
    let complete = {
        let Ok(mut request) = state.quit.try_lock() else {
            return Ok(());
        };
        if !request.as_ref().is_some_and(|(current, pending, _)| {
            current == token && pending.front().is_some_and(|next| next == label)
        }) {
            return Ok(());
        }
        acknowledge(&mut request, label, token, ready)
    };
    if let Some(intent) = complete {
        notify_reply(app, token, Ok(()));
        finish_shutdown(app, intent);
    } else if ready {
        emit_next_quit(app, token)?;
    } else {
        notify_reply(
            app,
            token,
            Err("Restart cancelled; all windows remain open".into()),
        );
        let _=app.emit("shutdown-aborted",serde_json::json!({"token":token,"message":"Close or restart cancelled. All windows remain open."}));
    }
    Ok(())
}

pub(crate) fn cancel_shutdown(app: &AppHandle, token: &str) -> Result<(), String> {
    let state = app.state::<DesktopWindows>();
    let mut request = state
        .quit
        .try_lock()
        .map_err(|_| "Still preparing to close; try cancelling again".to_string())?;
    if !request
        .as_ref()
        .is_some_and(|(current, _, _)| current == token)
    {
        return Ok(());
    }
    *request = None;
    drop(request);
    notify_reply(
        app,
        token,
        Err("Restart cancelled; all windows remain open".into()),
    );
    let _=app.emit("shutdown-aborted",serde_json::json!({"token":token,"message":"Close or restart cancelled. All windows remain open."}));
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
            ShutdownIntent::Quit,
        ));
        assert!(acknowledge(&mut request, "main", "previous", true).is_none());
        assert!(acknowledge(&mut request, "unknown", "current", true).is_none());
        assert!(acknowledge(&mut request, "other", "current", true).is_none()); // no prompt in a second window yet
        assert!(acknowledge(&mut request, "main", "current", true).is_none());
        assert!(acknowledge(&mut request, "main", "current", true).is_none());
        assert!(request.is_some());
        assert_eq!(
            acknowledge(&mut request, "other", "current", true),
            Some(ShutdownIntent::Quit)
        );
        assert!(request.is_none());
    }
    #[test]
    fn a_window_can_cancel_quit_without_closing_other_windows() {
        let mut request = Some((
            "token".to_string(),
            VecDeque::from(["main".to_string(), "other".to_string()]),
            ShutdownIntent::Quit,
        ));
        assert!(acknowledge(&mut request, "main", "token", false).is_none());
        assert!(request.is_none());
        assert!(acknowledge(&mut request, "other", "token", true).is_none());
    }
    #[test]
    fn restart_requires_all_windows_and_cancellation_cannot_leak_into_a_new_quit() {
        let mut request = Some((
            "restart".into(),
            VecDeque::from(["main".into(), "other".into()]),
            ShutdownIntent::Restart,
        ));
        assert_eq!(acknowledge(&mut request, "main", "restart", true), None);
        assert_eq!(acknowledge(&mut request, "other", "restart", false), None);
        assert!(request.is_none());
        request = Some((
            "quit".into(),
            VecDeque::from(["main".into()]),
            ShutdownIntent::Quit,
        ));
        assert_eq!(acknowledge(&mut request, "other", "restart", true), None);
        assert_eq!(
            acknowledge(&mut request, "main", "quit", true),
            Some(ShutdownIntent::Quit)
        );
        request = Some((
            "new".into(),
            VecDeque::from(["main".into(), "other".into()]),
            ShutdownIntent::Restart,
        ));
        assert_eq!(acknowledge(&mut request, "main", "new", true), None);
        assert_eq!(
            acknowledge(&mut request, "other", "new", true),
            Some(ShutdownIntent::Restart)
        );
    }
    #[test]
    fn window_creation_is_exclusive_nonblocking_and_rejects_shutdown() {
        let quit = Mutex::new(None);
        let permit = window_creation(&quit).unwrap();
        assert!(
            window_creation(&quit).is_err(),
            "Nested creation must reject without waiting on its own lock"
        );
        drop(permit);
        *quit.lock().unwrap() = Some((
            "restart".into(),
            VecDeque::from(["main".into()]),
            ShutdownIntent::Restart,
        ));
        assert!(window_creation(&quit).is_err());
        *quit.lock().unwrap() = None;
        assert!(window_creation(&quit).is_ok());
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
