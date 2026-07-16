//! System tray icon, menu, and click handlers.
//!
//! Layout (top → bottom):
//!   ☐ Pause        ← gates STT/TTS/summarizer dispatch via state::PAUSED
//!   Memory: X.X GB ← live label, refreshes on tray click + Pause toggle
//!   ─
//!   Settings...
//!   ─
//!   Switch Screen  ← only shown if 2+ monitors at startup
//!   ─
//!   Check for Updates...
//!   ─
//!   Quit
//!
//! `app.manage(memory_item.clone())` stashes the memory `MenuItem`
//! handle in app state so any callback (tray click, pause toggle,
//! direct click on the memory line) can update its text without
//! traversing Tauri 2's menu tree (which doesn't expose a getter).

use tauri::menu::{
    CheckMenuItem, CheckMenuItemBuilder, Menu, MenuBuilder, MenuItem, MenuItemBuilder,
    PredefinedMenuItem,
};
use tauri::tray::TrayIconBuilder;
use tauri::{Emitter, Manager};

use crate::state::PAUSED;

/// Single point of truth for setting the enabled/paused state. Updates
/// the atomic, syncs the tray's "Enabled" CheckMenuItem so external
/// toggles (anchor pip, command-line, etc.) keep the menu visual in
/// sync, and emits `enabled-changed` so the frontend can react.
pub fn set_paused(app: &tauri::AppHandle, paused: bool) {
    PAUSED.store(paused, std::sync::atomic::Ordering::Relaxed);
    eprintln!("[tray] paused = {}", paused);
    // Tray's persistent "Enabled" item: check = !paused.
    if let Some(item) = app.try_state::<CheckMenuItem<tauri::Wry>>() {
        let _ = item.set_checked(!paused);
    }
    // Refresh memory while we're at it — the user is often watching.
    if let Some(mi) = app.try_state::<MenuItem<tauri::Wry>>().map(|s| s.inner().clone()) {
        let _ = mi.set_text(format_memory_label());
    }
    // Frontend reacts: anchor docks to corner pip, creature leaves.
    let _ = app.emit("enabled-changed", !paused);
}

/// Build the canonical app menu (Pause / Memory / Settings / Switch Screen /
/// Check for Updates / Quit). Separate from `build()` so it can be reused
/// by the anchor right-click popup. Returns the constructed Menu.
///
/// Note: each invocation creates a fresh set of MenuItem handles. The
/// tray's memory item is the one stashed in app state (used by tray-click
/// refresh + Pause toggle). Popup-menu memory items show whatever
/// `format_memory_label()` returned at popup time.
pub fn build_main_menu(
    handle: &tauri::AppHandle,
) -> Result<(Menu<tauri::Wry>, CheckMenuItem<tauri::Wry>), Box<dyn std::error::Error>> {
    // "Enabled" semantics: check ON = running normally, check OFF = paused.
    let pause_toggle = CheckMenuItemBuilder::with_id("pause", "Enabled")
        .checked(!PAUSED.load(std::sync::atomic::Ordering::Relaxed))
        .build(handle)?;
    let memory_item: MenuItem<tauri::Wry> =
        MenuItemBuilder::with_id("memory", format_memory_label()).build(handle)?;

    let open_settings: MenuItem<tauri::Wry> =
        MenuItemBuilder::with_id("open-settings", "Settings...").build(handle)?;
    // available_monitors lives on AppHandle/App, not Manager — check via any
    // open webview window instead so this works from popup contexts too.
    let multi_screen = handle
        .webview_windows()
        .values()
        .next()
        .and_then(|w| w.available_monitors().ok())
        .map(|m| m.len() > 1)
        .unwrap_or(false);
    let switch_screen: MenuItem<tauri::Wry> =
        MenuItemBuilder::with_id("switch-screen", "Switch Screen").build(handle)?;
    let check_updates: MenuItem<tauri::Wry> =
        MenuItemBuilder::with_id("check-updates", "Check for Updates...").build(handle)?;
    let quit: MenuItem<tauri::Wry> =
        MenuItemBuilder::with_id("quit", "Quit").build(handle)?;
    let sep1 = PredefinedMenuItem::separator(handle)?;
    let sep2 = PredefinedMenuItem::separator(handle)?;
    let sep3 = PredefinedMenuItem::separator(handle)?;
    let sep4 = PredefinedMenuItem::separator(handle)?;

    let mut menu_builder = MenuBuilder::new(handle)
        .item(&pause_toggle)
        .item(&memory_item)
        .item(&sep1)
        .item(&open_settings)
        .item(&sep2);
    if multi_screen {
        menu_builder = menu_builder.item(&switch_screen).item(&sep3);
    }
    let menu = menu_builder
        .item(&check_updates)
        .item(&sep4)
        .item(&quit)
        .build()?;
    Ok((menu, pause_toggle))
}

/// Build and register the tray icon + menu. Call once during
/// `tauri::Builder::setup`. Stashes the memory `MenuItem` clone in
/// app state so other callbacks can refresh its text.
pub fn build(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    // Build the menu and capture the memory item for tray-click refresh.
    // We rebuild a parallel MenuItem clone via build_main_menu's flow so
    // app state can hold a handle without re-parsing the menu tree.
    let memory_item = MenuItemBuilder::with_id("memory", format_memory_label()).build(app)?;
    app.manage(memory_item.clone());

    let (menu, pause_toggle) = build_main_menu(app.handle())?;
    // Stash the tray's CheckMenuItem so set_paused() can keep its visual
    // check in sync when external surfaces (anchor pip, etc.) flip state.
    app.manage(pause_toggle);

    let icon = app
        .default_window_icon()
        .cloned()
        .expect("default window icon not found");

    TrayIconBuilder::with_id("main")
        .icon(icon)
        .tooltip("Native")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_tray_icon_event(|tray, _event| {
            let app = tray.app_handle();
            let mi = app.state::<MenuItem<tauri::Wry>>();
            let _ = mi.set_text(format_memory_label());
        })
        .on_menu_event(handle_menu_event)
        .build(app)?;

    Ok(())
}

/// Public so command handlers (e.g. anchor right-click popup) can attach
/// the same dispatcher to their own menus.
pub fn handle_menu_event(app: &tauri::AppHandle, event: tauri::menu::MenuEvent) {
    let id = event.id().as_ref().to_string();
    match id.as_str() {
        "pause" => {
            // Menu item is labeled "Enabled"; clicking toggles the gate.
            // The CheckMenuItem in the *menu being interacted with* flips
            // its own check automatically; set_paused() syncs the tray's
            // stashed item too in case this came from the popup menu.
            let new_paused = !PAUSED.load(std::sync::atomic::Ordering::Relaxed);
            set_paused(app, new_paused);
        }
        "memory" => {
            // Manual refresh — handy if the menu's been open long
            // enough that the value is stale.
            let mi = app.state::<MenuItem<tauri::Wry>>();
            let _ = mi.set_text(format_memory_label());
        }
        "open-settings" => {
            let _ = app.emit("open-settings", ());
        }
        "switch-screen" => switch_to_next_screen(app),
        "check-updates" => {
            // Emit an event the frontend can handle — the actual
            // updater integration (Tauri Updater plugin or a custom
            // HTTP check) isn't wired yet, so for now this just logs +
            // signals. Replace with the real updater call when that's
            // decided.
            eprintln!("[tray] check-updates requested");
            let _ = app.emit("check-updates", ());
        }
        "quit" => {
            app.exit(0);
        }
        _ => {}
    }
}

/// Cycle the overlay through every connected display. On macOS we go
/// through NSWindow because the window setup at startup uses
/// setFrame_display to cover the menu bar — Tauri's set_position /
/// set_size get clobbered by the NSWindow frame.
fn switch_to_next_screen(app: &tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    {
        use objc2::MainThreadMarker;
        use objc2_app_kit::{NSScreen, NSWindow};

        let Some(win) = app.get_webview_window("main") else { return };
        let Some(mtm) = MainThreadMarker::new() else {
            eprintln!("[tray] switch-screen must run on main thread");
            return;
        };
        let screens = NSScreen::screens(mtm);
        if screens.len() < 2 {
            eprintln!("[tray] only one screen; switch-screen no-op");
            return;
        }
        let ns_win_ptr = match win.ns_window() {
            Ok(p) => p,
            Err(_) => return,
        };
        unsafe {
            let ns_window: &NSWindow = &*(ns_win_ptr as *const NSWindow);
            let current = ns_window.screen();
            let mut idx = 0usize;
            if let Some(cur) = current.as_ref() {
                let cur_frame = cur.frame();
                for (i, s) in screens.iter().enumerate() {
                    let f = s.frame();
                    if f.origin.x == cur_frame.origin.x
                        && f.origin.y == cur_frame.origin.y
                    {
                        idx = i;
                        break;
                    }
                }
            }
            let next_idx = (idx + 1) % screens.len();
            let next = screens.objectAtIndex(next_idx);
            let frame = next.frame();
            ns_window.setFrame_display(frame, true);
            eprintln!(
                "[tray] switched to screen {} ({}x{} at {},{})",
                next_idx, frame.size.width, frame.size.height, frame.origin.x, frame.origin.y,
            );
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        // Non-macOS: Tauri's high-level APIs are sufficient since the
        // platform isn't doing the NSWindow override dance.
        if let Some(win) = app.get_webview_window("main") {
            if let Ok(monitors) = win.available_monitors() {
                if monitors.len() > 1 {
                    let current_pos = win.outer_position().ok();
                    let mut idx = 0usize;
                    if let Some(p) = current_pos {
                        for (i, m) in monitors.iter().enumerate() {
                            let mp = m.position();
                            if mp.x == p.x && mp.y == p.y {
                                idx = i;
                                break;
                            }
                        }
                    }
                    let next = &monitors[(idx + 1) % monitors.len()];
                    let _ = win.set_position(*next.position());
                    let _ = win.set_size(*next.size());
                }
            }
        }
    }
}

// ── Memory readout ─────────────────────────────────────────────────

/// Read this process's resident-set size in bytes via sysinfo. Cheap
/// enough to call on each tray-menu open. Returns 0 if the process
/// can't introspect itself (shouldn't happen on a normal launch).
fn process_memory_bytes() -> u64 {
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
    let pid = Pid::from(std::process::id() as usize);
    let mut sys = System::new();
    sys.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[pid]),
        true,
        ProcessRefreshKind::new().with_memory(),
    );
    sys.process(pid).map(|p| p.memory()).unwrap_or(0)
}

/// Format bytes as a tray-menu-friendly memory label. Picks GB once
/// past the 900 MB threshold so the value transitions cleanly.
fn format_memory_label() -> String {
    let bytes = process_memory_bytes();
    if bytes == 0 {
        return "Memory: —".to_string();
    }
    let mb = bytes as f64 / 1_048_576.0;
    if mb >= 900.0 {
        format!("Memory: {:.2} GB", mb / 1024.0)
    } else {
        format!("Memory: {:.0} MB", mb)
    }
}
