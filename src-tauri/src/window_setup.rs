//! Window-management plumbing for the transparent overlay.
//!
//! Three concerns live here:
//!
//! 1. **Initial NSWindow configuration** (`configure_main_window`) —
//!    transparency, level, collection behavior so the overlay sits
//!    above other apps, joins all Spaces, and ignores Cmd-Tab. Sized
//!    to whatever screen the cursor is on at launch.
//!
//! 2. **Click-through gating** (`apply_cursor_state`,
//!    `set_settings_open`, `start_anchor_proximity_poll`) — the
//!    overlay is normally cursor-transparent so clicks pass through to
//!    apps behind. The settings panel + anchor hover both flip flags
//!    on `CursorCtl`; this module reads those flags and tells the
//!    NSWindow whether to capture cursor events.
//!
//! 3. **Display-change reactions** (`reposition_to_mouse_screen`,
//!    `register_screen_event_observers`) — keep the overlay on the
//!    screen the user is actually looking at, even after sleep, lid
//!    open/close, or hot-plug.

use std::sync::atomic::Ordering;

use tauri::Manager;

use crate::hotkeys::current_mouse_pos;
use crate::state::CursorCtl;

/// Read CursorCtl's reasons-to-be-interactive and tell the NSWindow
/// whether to swallow cursor events. Cursor events go to the overlay
/// when the settings panel is open OR the user is hovering the voice
/// anchor; otherwise the window is click-through and the user
/// interacts with whatever app is underneath.
pub fn apply_cursor_state(handle: &tauri::AppHandle) {
    let ctl = handle.state::<std::sync::Arc<CursorCtl>>();
    let interactive = ctl.is_interactive();
    if let Some(win) = handle.get_webview_window("main") {
        let _ = win.set_ignore_cursor_events(!interactive);
    }
}

#[tauri::command]
pub fn set_settings_open(open: bool, handle: tauri::AppHandle) {
    let ctl = handle.state::<std::sync::Arc<CursorCtl>>();
    ctl.settings_open.store(open, Ordering::Relaxed);
    apply_cursor_state(&handle);
}

/// Called from JS at drag start (true) and drag end / inertia rest
/// (false). Forces the overlay window non-click-through for the entire
/// drag — see `CursorCtl::anchor_dragging` for why this is needed.
#[tauri::command]
pub fn set_anchor_dragging(active: bool, handle: tauri::AppHandle) {
    let ctl = handle.state::<std::sync::Arc<CursorCtl>>();
    ctl.anchor_dragging.store(active, Ordering::Relaxed);
    apply_cursor_state(&handle);
}

/// Background poll that flips `CursorCtl::anchor_hover` based on
/// mouse-vs-anchor distance. Driven by reading the anchor's normalised
/// position from settings every 60 ms — no JS round-trip needed.
pub fn start_anchor_proximity_poll(handle: tauri::AppHandle) {
    use crate::state::AppSettings;

    std::thread::spawn(move || {
        // Visible orb disc is 27 px radius; 55 covers it with a comfortable
        // grab margin. The JS hover-pin (set_anchor_dragging on mouseenter)
        // extends interactivity to the full 85 px DOM zone once the cursor
        // has entered. Matching HOVER_RADIUS to SIZE/2 (85) made the boundary
        // oscillate: the poll would flip click-through at exactly 85 pt,
        // swallowing mouseleave and mousedown and freezing hover effects.
        const HOVER_RADIUS: f64 = 55.0;
        loop {
            std::thread::sleep(std::time::Duration::from_millis(60));

            let (fx, fy) = {
                let s = match handle.try_state::<AppSettings>() {
                    Some(s) => s,
                    None => continue,
                };
                let guard = match s.settings.lock() {
                    Ok(g) => g,
                    Err(_) => continue,
                };
                (guard.voice_anchor_x as f64, guard.voice_anchor_y as f64)
            };

            let Some(window) = handle.get_webview_window("main") else { continue };

            // In dev mode Tauri's inner_size() may return the config size
            // (800×600) even after configure_main_window has resized the
            // NSWindow to fullscreen — the Tauri API caches until a proper
            // Cocoa resize event fires. Read the NSWindow frame directly so
            // dev and release behave identically.
            #[cfg(target_os = "macos")]
            let (screen_w, screen_h) = {
                use objc2_app_kit::NSWindow;
                if let Ok(ptr) = window.ns_window() {
                    unsafe {
                        let ns: &NSWindow = &*(ptr as *const NSWindow);
                        let f = ns.frame();
                        (f.size.width, f.size.height)
                    }
                } else {
                    let s = window.inner_size().unwrap_or_default();
                    let sc = window.scale_factor().unwrap_or(1.0);
                    (s.width as f64 / sc, s.height as f64 / sc)
                }
            };

            #[cfg(not(target_os = "macos"))]
            let (screen_w, screen_h) = {
                let s = window.inner_size().unwrap_or_default();
                let sc = window.scale_factor().unwrap_or(1.0);
                (s.width as f64 / sc, s.height as f64 / sc)
            };

            // NSWindow.frame origin in Cocoa coords (bottom-left origin, y up).
            // current_mouse_pos() uses CGEvent which also has top-left origin
            // (y down), so we get the screen height to flip the y of the origin.
            #[cfg(target_os = "macos")]
            let win_origin = {
                use objc2_app_kit::{NSScreen, NSWindow};
                use objc2::MainThreadMarker;
                if let Ok(ptr) = window.ns_window() {
                    unsafe {
                        let ns: &NSWindow = &*(ptr as *const NSWindow);
                        let f = ns.frame();
                        // Primary screen height for Cocoa→CG coord flip.
                        let primary_h = if let Some(mtm) = MainThreadMarker::new() {
                            NSScreen::screens(mtm)
                                .iter()
                                .next()
                                .map(|s| s.frame().size.height)
                                .unwrap_or(screen_h)
                        } else { screen_h };
                        // CG y = primary_h - (cocoa_y + window_h)
                        let cg_y = primary_h - (f.origin.y + f.size.height);
                        (f.origin.x, cg_y)
                    }
                } else {
                    let p = window.inner_position().unwrap_or_default();
                    let sc = window.scale_factor().unwrap_or(1.0);
                    (p.x as f64 / sc, p.y as f64 / sc)
                }
            };

            #[cfg(not(target_os = "macos"))]
            let win_origin = {
                let p = window.inner_position().unwrap_or_default();
                let sc = window.scale_factor().unwrap_or(1.0);
                (p.x as f64 / sc, p.y as f64 / sc)
            };

            let (mx, my) = current_mouse_pos();
            let anchor_x = win_origin.0 + fx * screen_w;
            let anchor_y = win_origin.1 + fy * screen_h;
            let dx = mx - anchor_x;
            let dy = my - anchor_y;
            let near = (dx * dx + dy * dy) < HOVER_RADIUS * HOVER_RADIUS;

            let ctl = handle.state::<std::sync::Arc<CursorCtl>>();
            let prev = ctl.anchor_hover.load(Ordering::Relaxed);
            // Don't flip to non-hover while a drag is active — the
            // saved anchor position lags the live orb position so the
            // poll would otherwise kill interactivity mid-drag.
            let dragging = ctl.anchor_dragging.load(Ordering::Relaxed);
            if near != prev && !(prev && !near && dragging) {
                ctl.anchor_hover.store(near, Ordering::Relaxed);
                apply_cursor_state(&handle);
            }
        }
    });
}

/// Reposition the overlay window to whichever screen the mouse is on.
/// Uses NSWindow directly (rather than Tauri's set_position/set_size)
/// because the launch-time setup also goes through NSWindow's
/// `setFrame_display` to cover the menu bar — high-level Tauri APIs
/// would get clobbered by the existing NSWindow frame.
pub fn reposition_to_mouse_screen(app: &tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    {
        use objc2::MainThreadMarker;
        use objc2_app_kit::{NSScreen, NSWindow};

        let Some(window) = app.get_webview_window("main") else { return };
        let (mx, _) = current_mouse_pos();

        if let Some(mtm) = MainThreadMarker::new() {
            let screens = NSScreen::screens(mtm);
            let mut target_frame = None;

            for screen in screens.iter() {
                let f = screen.frame();
                if mx >= f.origin.x && mx < f.origin.x + f.size.width {
                    target_frame = Some(f);
                    break;
                }
            }

            if let Some(frame) = target_frame {
                let ns_win_ptr = window.ns_window().expect("ns_window");
                unsafe {
                    let ns_window: &NSWindow = &*(ns_win_ptr as *const NSWindow);
                    ns_window.setFrame_display(frame, true);
                }
            }
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
    }
}

/// Wake + display-reconfiguration observers.
///
/// The overlay used to get stranded on the wrong screen after the Mac
/// slept, woke, or re-enumerated monitors — the periodic mouse-delta
/// poll wouldn't fire until the cursor moved >500 px, which often
/// never happened on wake. We subscribe to three Cocoa notifications
/// and call `reposition_to_mouse_screen` from each handler on the main
/// thread:
///
/// - `NSWorkspaceDidWakeNotification`        — system wake
/// - `NSWorkspaceScreensDidWakeNotification` — display wake (lid, screensaver)
/// - `NSApplicationDidChangeScreenParametersNotification` — hot-plug, resolution change
///
/// Observers stay registered for the process lifetime. The block that
/// holds the `AppHandle` is intentionally leaked so Cocoa keeps a
/// live callback pointer — the process owns the allocation either way.
#[cfg(target_os = "macos")]
pub fn register_screen_event_observers(app: tauri::AppHandle) {
    use block2::RcBlock;
    use objc2_app_kit::{
        NSApplicationDidChangeScreenParametersNotification, NSWorkspace,
        NSWorkspaceDidWakeNotification, NSWorkspaceScreensDidWakeNotification,
    };
    use objc2_foundation::{NSNotification, NSNotificationCenter, NSOperationQueue};

    unsafe {
        let workspace = NSWorkspace::sharedWorkspace();
        let ws_center = workspace.notificationCenter();
        let default_center = NSNotificationCenter::defaultCenter();
        let main_queue = NSOperationQueue::mainQueue();

        // Debounce: wake produces bursts of notifications (wake +
        // screens-wake + screen-params) within ~1 s. Collapse them so
        // we don't thrash the window position. `None` = haven't fired
        // yet, so the first event always runs.
        let last_fired: std::sync::Arc<std::sync::Mutex<Option<std::time::Instant>>> =
            std::sync::Arc::new(std::sync::Mutex::new(None));

        let handle = app.clone();
        let last_fired_cl = last_fired.clone();
        let block = RcBlock::new(move |_notif: std::ptr::NonNull<NSNotification>| {
            let mut last = last_fired_cl.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(prev) = *last {
                if prev.elapsed() < std::time::Duration::from_millis(250) {
                    return;
                }
            }
            *last = Some(std::time::Instant::now());
            drop(last);
            reposition_to_mouse_screen(&handle);
        });

        ws_center.addObserverForName_object_queue_usingBlock(
            Some(NSWorkspaceDidWakeNotification),
            None,
            Some(&main_queue),
            &block,
        );
        ws_center.addObserverForName_object_queue_usingBlock(
            Some(NSWorkspaceScreensDidWakeNotification),
            None,
            Some(&main_queue),
            &block,
        );
        default_center.addObserverForName_object_queue_usingBlock(
            Some(NSApplicationDidChangeScreenParametersNotification),
            None,
            Some(&main_queue),
            &block,
        );

        // Keep the block alive for process lifetime — observers hold a
        // weak reference to it and we never unregister.
        std::mem::forget(block);
    }
}

#[cfg(not(target_os = "macos"))]
pub fn register_screen_event_observers(_app: tauri::AppHandle) {}

/// Configure the main window at startup: transparent fullscreen
/// overlay with click-through, sits above other apps, follows the
/// user across Spaces, ignores Cmd-Tab. Sized to whatever screen the
/// cursor is on at launch.
pub fn configure_main_window(app: &tauri::App) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_ignore_cursor_events(true);

        #[cfg(target_os = "macos")]
        {
            use objc2::MainThreadMarker;
            use objc2_app_kit::{NSColor, NSScreen, NSWindow, NSWindowCollectionBehavior};

            let mtm = MainThreadMarker::new().expect("setup must be on main thread");

            // Cover the screen that has the mouse cursor.
            let (mx, _my) = current_mouse_pos();
            let screens = NSScreen::screens(mtm);
            let mut target_frame = None;

            for screen in screens.iter() {
                let f = screen.frame();
                if mx >= f.origin.x && mx < f.origin.x + f.size.width {
                    target_frame = Some(f);
                    break;
                }
            }

            // Fall back to main screen if no match.
            let frame = target_frame.unwrap_or_else(|| {
                NSScreen::mainScreen(mtm).map(|s| s.frame()).unwrap_or_default()
            });

            let ns_win_ptr = window
                .ns_window()
                .expect("failed to get ns_window pointer");

            unsafe {
                let ns_window: &NSWindow = &*(ns_win_ptr as *const NSWindow);
                // Position via NSWindow directly to cover full screen including menu bar.
                ns_window.setFrame_display(frame, true);
                ns_window.setOpaque(false);
                let clear = NSColor::clearColor();
                ns_window.setBackgroundColor(Some(&clear));
                ns_window.setHasShadow(false);
                ns_window.setLevel(25);
                ns_window.setCollectionBehavior(
                    NSWindowCollectionBehavior::CanJoinAllSpaces
                        | NSWindowCollectionBehavior::FullScreenAuxiliary
                        | NSWindowCollectionBehavior::Stationary
                        | NSWindowCollectionBehavior::IgnoresCycle,
                );
            }
        }
    }
}
