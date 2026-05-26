# Sleep/Wake + Multi-Monitor Screen Tracking

## The bug

When the Mac goes to sleep with the overlay on one screen and wakes with the user
working on a different screen, the overlay stays stuck on the old screen. It does
not follow the user back to the active display.

## What exists today

Two places reposition the overlay:

- [lib.rs:898–929](../src-tauri/src/lib.rs#L898-L929) — `reposition_to_mouse_screen()`:
  reads `NSScreen::screens()`, finds the screen whose frame contains the current
  mouse X, calls `NSWindow::setFrame_display`.
- [lib.rs:1580–1596](../src-tauri/src/lib.rs#L1580-L1596) — a 5-second polling loop that
  calls `reposition_to_mouse_screen` **only** when the mouse has moved >500 px
  horizontally since the last check.
- Also invoked directly at the start of `do_speak_selection` and `do_speak_text`.

### Why it breaks after wake

1. The 5 s poll uses a mouse-delta heuristic. If the user wakes with the cursor
   roughly where it was (common — they haven't moved yet), the 500 px threshold is
   never crossed and no reposition fires.
2. There is **no listener for macOS sleep/wake or display-reconfiguration events**.
   The window stays where the compositor last put it.
3. Screens can change identity on wake (external monitor hot-plug, resolution
   change, built-in display sleeping independently). A frame captured before sleep
   may no longer correspond to the same physical screen afterwards.

## Techniques available on macOS

### 1. NSWorkspace sleep/wake notifications (recommended)

`NSWorkspace.shared.notificationCenter` broadcasts four events we care about:

| Notification | Fires when |
|---|---|
| `NSWorkspaceWillSleepNotification` | System is about to sleep |
| `NSWorkspaceDidWakeNotification` | System just woke |
| `NSWorkspaceScreensDidSleepNotification` | Displays slept (lid close, screensaver) but system may be awake |
| `NSWorkspaceScreensDidWakeNotification` | Displays woke |

Subscribe via `addObserver:selector:name:object:` on the workspace notification
center (not the default center — this is a common mistake; NSWorkspace
notifications are only posted to its own center).

### 2. Display-configuration change

| Notification / API | What it catches |
|---|---|
| `NSApplicationDidChangeScreenParametersNotification` | Screens added, removed, moved, or resolution changed. Posted to the **default** NSNotificationCenter. |
| `CGDisplayRegisterReconfigurationCallback` (CoreGraphics) | Lower-level display events; finer-grained but more complex. Usually not needed. |

These fire on hot-plug (dock connect/disconnect) and are often fired *after* wake
when the external display re-enumerates — so listening to both sleep/wake and
screen-parameters is the safest combo.

### 3. Stable screen identity

Screens should be tracked by **CGDirectDisplayID**, not by index or frame.
Indexes reorder; frames move when displays are rearranged. The display ID
persists across sleep/wake for the same physical monitor.

```objc
NSNumber *num = screen.deviceDescription[@"NSScreenNumber"];
CGDirectDisplayID displayID = num.unsignedIntValue;
```

From Rust with `objc2_app_kit`, `NSScreen::deviceDescription()` returns a
dictionary you can pull `NSScreenNumber` from.

### 4. Remembering the "intended" screen

On the native side we have two reasonable options:

- **Last-known display ID**: remember which `CGDirectDisplayID` the window was
  on before sleep. On wake, if that ID is still present, put the window there;
  otherwise fall back to the mouse's current screen.
- **Always follow the mouse**: on every wake / screen-parameters event, just
  call `reposition_to_mouse_screen`. Simpler and matches the existing mental
  model (the overlay lives where you're working, identified by cursor).

Given the app is already mouse-screen-driven, **option B** is the natural fit.

## Recommended implementation

Minimal, low-risk, fits the existing architecture:

1. **Replace the mouse-delta poll** (or augment it) with event-driven reposition.
2. **Subscribe to three notifications** during setup:
   - `NSWorkspaceDidWakeNotification` (workspace center)
   - `NSWorkspaceScreensDidWakeNotification` (workspace center)
   - `NSApplicationDidChangeScreenParametersNotification` (default center)
3. Each handler does the same thing: schedule a reposition on the main thread,
   ideally with a small debounce (~250 ms) because multiple notifications often
   fire back-to-back on wake.
4. Keep the 5 s polling loop as a safety net, but drop the 500 px threshold — let
   it call `reposition_to_mouse_screen` unconditionally. The cost is trivial (one
   frame calculation + a no-op `setFrame_display` when already correct).
5. Optional: before sleep, record the current display ID so we can log /
   troubleshoot cases where the user wakes and the overlay doesn't follow.

### Rust sketch

In Rust with `objc2` the registration uses `NSNotificationCenter` via
`objc2-foundation` plus a block. Pseudocode:

```rust
use objc2_foundation::{NSNotificationCenter, NSOperationQueue, NSString};
use objc2_app_kit::NSWorkspace;

// In setup(), after window is created:
let handle = app.handle().clone();
let workspace = NSWorkspace::sharedWorkspace();
let wc = workspace.notificationCenter();

let on_wake = move |_: &NSNotification| {
    reposition_to_mouse_screen(&handle);
};

wc.addObserverForName_object_queue_usingBlock(
    NSWorkspaceDidWakeNotification,
    None,
    NSOperationQueue::mainQueue(),
    &on_wake,
);
// …plus one for ScreensDidWake on wc, and one on default center for
// NSApplicationDidChangeScreenParametersNotification.
```

Feature flags needed in `Cargo.toml`:

- `objc2-app-kit`: add `"NSWorkspace"` to the features list
- `objc2-foundation`: add `"NSNotification"`, `"NSNotificationCenter"`,
  `"NSOperationQueue"`, `"NSString"`

The notification constants are exported as `objc2_app_kit::NSWorkspaceDidWakeNotification`
and friends once the `NSWorkspace` feature is enabled.

### Debounce + main-thread safety

- `setFrame_display` must be called on the main thread. Using
  `NSOperationQueue::mainQueue()` as the delivery queue in
  `addObserverForName:object:queue:usingBlock:` handles that.
- Wake typically produces bursts (wake + screens wake + screen-params change all
  within ~1 s). A simple "last-reposition timestamp; skip if <250 ms since last"
  guard prevents redundant moves.

## Edge cases to watch

| Case | Behavior we want |
|---|---|
| Wake, cursor already on correct screen | Reposition is a no-op; harmless |
| Wake, external monitor asleep/disconnected | `NSScreen::screens()` returns only awake screens; `reposition_to_mouse_screen` falls through to main screen — need to verify the fallback branch |
| Clamshell → external-only mode mid-session | `DidChangeScreenParameters` fires; reposition to mouse screen (now the external) |
| Lid close → Screens sleep (system awake) | `ScreensDidWake` fires on re-open; reposition |
| Fast user switching | Overlay on another user's session — out of scope, but notifications fire again when the original user returns |
| Space switching | Already handled by `CanJoinAllSpaces`; no new work needed |

## Testing checklist

- [ ] Overlay on screen A, close lid → open lid: overlay on the screen with cursor
- [ ] Overlay on external, unplug dock, replug: overlay follows cursor
- [ ] Put Mac to sleep (Apple menu → Sleep), wake with cursor on different screen
- [ ] Change display resolution via System Settings mid-session
- [ ] Screensaver kicks in, dismiss: overlay still correctly placed

## Alternative considered: just follow the mouse aggressively

Dropping the 500 px threshold in the existing 5 s poll would fix the reported bug
in isolation (within 5 s of moving the cursor, the overlay would follow). It's a
one-line change. Downsides:

- Up to 5 s of visible wrongness after wake
- Still does nothing if the user wakes and immediately looks at the "wrong"
  screen without moving the cursor

The notification-driven approach makes the fix feel instant and also catches
monitor hot-plug, which the poll misses entirely. Recommended as the real fix;
the threshold drop is a fine stop-gap if we want to ship something today.

## Summary

- **Is this possible?** Yes — it's the standard macOS pattern.
- **Core technique**: subscribe to `NSWorkspaceDidWakeNotification`,
  `NSWorkspaceScreensDidWakeNotification`, and
  `NSApplicationDidChangeScreenParametersNotification`; call
  `reposition_to_mouse_screen` from each, on the main thread, with a small
  debounce.
- **Secondary**: drop the 500 px mouse-delta gate on the 5 s poll so it acts as a
  belt-and-braces safety net.
- **Optional polish**: track CGDirectDisplayID so we can log which physical
  screen the overlay targeted on each event — useful for debugging.
