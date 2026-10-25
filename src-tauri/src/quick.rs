//! The quick terminal (Ghostty's quick terminal, iTerm2's hotkey window): a borderless,
//! always-on-top window with local shells, shown and hidden by a global hotkey or by running
//! `hbox-term --toggle-quick` (for desktops where apps cannot grab global keys, such as GNOME on
//! Wayland, which also ignores window positions).

use std::sync::Mutex;
use tauri::{
    AppHandle, Manager, PhysicalPosition, PhysicalSize, Runtime, WebviewUrl, WebviewWindowBuilder,
    WindowEvent,
};

pub const LABEL: &str = "quick";
pub const TOGGLE_FLAG: &str = "--toggle-quick";

/// Ghostty's quick-terminal-position, quick-terminal-size and quick-terminal-autohide.
#[derive(Debug, Clone, PartialEq)]
pub struct QuickConfig {
    pub position: String,
    pub size: String,
    pub autohide: bool,
}

impl Default for QuickConfig {
    fn default() -> Self {
        Self {
            position: "top".into(),
            size: String::new(),
            autohide: true,
        }
    }
}

static CONFIG: Mutex<Option<QuickConfig>> = Mutex::new(None);

pub fn configure(config: QuickConfig) {
    if let Ok(mut current) = CONFIG.lock() {
        *current = Some(config);
    }
}

fn config() -> QuickConfig {
    CONFIG
        .lock()
        .ok()
        .and_then(|config| config.clone())
        .unwrap_or_default()
}

/// One `quick-terminal-size` value: `40%` of the screen, or pixels (`800px` or `800`).
fn size_value(value: &str, total: u32) -> Option<u32> {
    let value = value.trim();
    if let Some(percent) = value.strip_suffix('%') {
        let percent: f64 = percent.trim().parse().ok()?;
        return Some(((total as f64) * percent.clamp(1.0, 100.0) / 100.0).round() as u32);
    }
    let pixels: u32 = value
        .strip_suffix("px")
        .unwrap_or(value)
        .trim()
        .parse()
        .ok()?;
    Some(pixels.clamp(1, total))
}

/// The window rectangle within the work area (x, y, width, height). The first size value is the
/// dimension away from the edge (height for top/bottom), the second the one along it.
pub fn geometry(work: (i32, i32, u32, u32), position: &str, size: &str) -> (i32, i32, u32, u32) {
    let (x, y, width, height) = work;
    let mut values = size.split(',');
    let primary = values.next().unwrap_or("");
    let secondary = values.next().unwrap_or("");
    match position {
        "bottom" | "top" => {
            let h = size_value(primary, height).unwrap_or(height * 2 / 5);
            let w = size_value(secondary, width).unwrap_or(width);
            let left = x + ((width - w) / 2) as i32;
            let top = if position == "top" {
                y
            } else {
                y + (height - h) as i32
            };
            (left, top, w, h)
        }
        "left" | "right" => {
            let w = size_value(primary, width).unwrap_or(width * 2 / 5);
            let h = size_value(secondary, height).unwrap_or(height);
            let left = if position == "left" {
                x
            } else {
                x + (width - w) as i32
            };
            (left, y + ((height - h) / 2) as i32, w, h)
        }
        _ => {
            let w = size_value(primary, width).unwrap_or(width * 3 / 5);
            let h = size_value(secondary, height).unwrap_or(height * 3 / 5);
            (
                x + ((width - w) / 2) as i32,
                y + ((height - h) / 2) as i32,
                w,
                h,
            )
        }
    }
}

/// Places the window on the monitor with the mouse pointer (or the primary one).
fn place<R: Runtime>(app: &AppHandle<R>, window: &tauri::WebviewWindow<R>) {
    let cursor = app.cursor_position().ok();
    let monitors = app.available_monitors().unwrap_or_default();
    let monitor = cursor
        .and_then(|cursor| {
            monitors.into_iter().find(|monitor| {
                let (position, size) = (monitor.position(), monitor.size());
                cursor.x >= position.x as f64
                    && cursor.y >= position.y as f64
                    && cursor.x < (position.x + size.width as i32) as f64
                    && cursor.y < (position.y + size.height as i32) as f64
            })
        })
        .or_else(|| app.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else {
        return;
    };
    let work = monitor.work_area();
    let config = config();
    let (x, y, width, height) = geometry(
        (
            work.position.x,
            work.position.y,
            work.size.width,
            work.size.height,
        ),
        &config.position,
        &config.size,
    );
    let _ = window.set_size(PhysicalSize::new(width, height));
    let _ = window.set_position(PhysicalPosition::new(x, y));
}

fn create<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<tauri::WebviewWindow<R>> {
    let window =
        WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("index.html?quick=1".into()))
            .title("hbox-term quick terminal")
            .decorations(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(false)
            .visible(false)
            .build()?;
    let handle = window.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::Focused(false) = event {
            if config().autohide {
                let _ = handle.hide();
            }
        }
    });
    Ok(window)
}

/// Shows the quick terminal (creating it the first time), or hides it if it has focus.
pub fn toggle<R: Runtime>(app: &AppHandle<R>) {
    let window = match app.get_webview_window(LABEL) {
        Some(window) => window,
        None => match create(app) {
            Ok(window) => window,
            Err(error) => {
                eprintln!("hbox-term quick terminal unavailable: {error}");
                return;
            }
        },
    };
    let visible = window.is_visible().unwrap_or(false);
    if visible && window.is_focused().unwrap_or(false) {
        let _ = window.hide();
        return;
    }
    place(app, &window);
    let _ = window.show();
    let _ = window.set_focus();
}

#[cfg(test)]
mod tests {
    use super::*;

    const WORK: (i32, i32, u32, u32) = (0, 30, 1920, 1050);

    #[test]
    fn top_by_default_forty_percent() {
        assert_eq!(geometry(WORK, "top", ""), (0, 30, 1920, 420));
        assert_eq!(geometry(WORK, "bottom", "50%"), (0, 555, 1920, 525));
    }

    #[test]
    fn sizes_in_percent_and_pixels() {
        assert_eq!(geometry(WORK, "top", "30%,1000px"), (460, 30, 1000, 315));
        assert_eq!(geometry(WORK, "left", "600"), (0, 30, 600, 1050));
        assert_eq!(geometry(WORK, "right", "25%"), (1440, 30, 480, 1050));
        assert_eq!(
            geometry(WORK, "center", "800px,600px"),
            (560, 255, 800, 600)
        );
    }

    #[test]
    fn oversized_and_invalid_values() {
        assert_eq!(geometry(WORK, "top", "5000px"), (0, 30, 1920, 1050));
        assert_eq!(geometry(WORK, "top", "huge"), (0, 30, 1920, 420));
    }
}
