import { createSignal, createEffect, onCleanup, Show } from "solid-js";
import { FONT, ACTIVE_COLOR } from "../theme";
import { SUPPORTED_HOTKEYS, HOTKEY_LABEL, MODIFIER_ORDER } from "../config";
import { RowShell } from "./RowShell";

/// Map an `e.code` from the keydown event into the canonical key name
/// the Rust parser expects. Letters (`KeyA` → `A`), digits (`Digit0` →
/// `0`), function keys (`F1`–`F20`) and nav keys (`PageUp` etc.) pass
/// through; anything else returns null and is rejected.
function codeToKeyName(code: string): string | null {
  if (code.startsWith("Key") && code.length === 4) {
    return code.slice(3); // "KeyA" → "A"
  }
  if (code.startsWith("Digit") && code.length === 6) {
    return code.slice(5); // "Digit0" → "0"
  }
  if (SUPPORTED_HOTKEYS.has(code)) return code;
  return null;
}

/// True if the key + modifier combination is acceptable as a hotkey.
/// Bare letters/digits are rejected (would fire on every keystroke);
/// they must be accompanied by at least one modifier. Bare nav and
/// function keys are fine since they don't appear in typing.
function isAcceptable(key: string, hasModifier: boolean): boolean {
  const isLetterOrDigit = key.length === 1 && /^[A-Z0-9]$/.test(key);
  if (isLetterOrDigit) return hasModifier;
  return SUPPORTED_HOTKEYS.has(key);
}

/// Format a hotkey as the canonical string the Rust side parses.
/// `Cmd+Shift+A`, `Ctrl+F1`, or a bare `PageDown` when no modifiers.
function formatShortcut(
  key: string,
  mods: { cmd: boolean; ctrl: boolean; alt: boolean; shift: boolean },
): string {
  const parts: string[] = [];
  for (const m of MODIFIER_ORDER) {
    if (m === "Cmd" && mods.cmd) parts.push("Cmd");
    if (m === "Ctrl" && mods.ctrl) parts.push("Ctrl");
    if (m === "Alt" && mods.alt) parts.push("Alt");
    if (m === "Shift" && mods.shift) parts.push("Shift");
  }
  parts.push(key);
  return parts.join("+");
}

/// Pretty label for the chiclet — collapses long modifier names to
/// glyphs so a chord like `Cmd+Shift+A` reads as `⌘⇧A`.
function prettyLabel(value: string): string {
  if (HOTKEY_LABEL[value]) return HOTKEY_LABEL[value];
  if (!value.includes("+")) return value;
  const parts = value.split("+");
  const key = parts.pop() ?? "";
  const glyphs = parts
    .map((p) => {
      const lo = p.toLowerCase();
      if (lo === "cmd" || lo === "command" || lo === "meta") return "⌘";
      if (lo === "ctrl" || lo === "control") return "⌃";
      if (lo === "alt" || lo === "opt" || lo === "option") return "⌥";
      if (lo === "shift") return "⇧";
      return p;
    })
    .join("");
  return glyphs + key;
}

/** Click-to-capture hotkey binder. Shows the currently bound key as a
 *  chiclet; click to enter "recording" mode, then press the new key.
 *  Escape cancels.
 *
 *  Why DOM keydown rather than a Tauri call: the settings panel is
 *  focused DOM while open, so key events route through the web view
 *  first. We intercept them before they can reach the CGEvent tap and
 *  accidentally trigger STT. Letters/digits are only allowed when paired
 *  with a modifier (`Cmd+Shift+A`); bare nav/function keys are also
 *  accepted (see `SUPPORTED_HOTKEYS`). */
export function HotkeyCaptureRow(props: {
  value: string;
  onChange: (value: string) => void;
  label?: string;
  hint?: string;
}) {
  const [recording, setRecording] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const stopRecording = () => {
    setRecording(false);
    setError(null);
  };

  // Global keydown listener, installed only while recording so we don't
  // hijack keys in the rest of the app.
  createEffect(() => {
    if (!recording()) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code === "Escape" && !(e.metaKey || e.ctrlKey || e.altKey)) {
        stopRecording();
        return;
      }
      // Skip pure-modifier keydowns — wait for the user to press the
      // actual key while holding the modifier.
      if (
        e.code === "MetaLeft" ||
        e.code === "MetaRight" ||
        e.code === "ControlLeft" ||
        e.code === "ControlRight" ||
        e.code === "AltLeft" ||
        e.code === "AltRight" ||
        e.code === "ShiftLeft" ||
        e.code === "ShiftRight"
      ) {
        return;
      }
      const key = codeToKeyName(e.code);
      if (!key) {
        setError(
          `${e.code} isn't supported — try a letter/digit with a modifier (Cmd+Shift+A), F1–F20, or PageUp/Down/Home/End/Insert/Delete`,
        );
        return;
      }
      const mods = {
        cmd: e.metaKey,
        ctrl: e.ctrlKey,
        alt: e.altKey,
        shift: e.shiftKey,
      };
      const hasModifier = mods.cmd || mods.ctrl || mods.alt || mods.shift;
      if (!isAcceptable(key, hasModifier)) {
        setError(
          `${key} needs at least one modifier (Cmd / Ctrl / Alt / Shift)`,
        );
        return;
      }
      props.onChange(formatShortcut(key, mods));
      stopRecording();
    };
    document.addEventListener("keydown", onKey, { capture: true });
    onCleanup(() =>
      document.removeEventListener("keydown", onKey, { capture: true } as any),
    );
  });

  return (
    <RowShell
      label={props.label ?? "Hotkey"}
      hint={
        props.hint ??
        "Global key to hold for push-to-talk voice capture. Click the chiclet, then press your chosen key (or chord — e.g. Cmd+Shift+A). Supported: F1–F20, PageUp/Down, Home/End, Insert/Delete, or any letter/digit with a modifier."
      }
    >
      <div style={{ display: "flex", "align-items": "center", gap: "6px" }}>
        <Show when={error()}>
          <span
            style={{
              "font-size": "10px",
              color: "rgba(255,140,140,0.9)",
              "font-family": FONT,
              "max-width": "180px",
              "text-align": "right",
            }}
          >
            {error()}
          </span>
        </Show>
        <button
          type="button"
          onClick={() => {
            if (recording()) stopRecording();
            else {
              setError(null);
              setRecording(true);
            }
          }}
          style={{
            "font-family": FONT,
            "font-size": "12px",
            "font-weight": "500",
            color: recording() ? "#ffffff" : "var(--text-primary)",
            background: recording() ? ACTIVE_COLOR : "var(--control-bg)",
            border: recording()
              ? `2px solid ${ACTIVE_COLOR}`
              : "2px solid var(--control-border)",
            "border-radius": "4px",
            padding: "3px 10px",
            "min-width": "90px",
            cursor: "pointer",
            outline: "none",
            transition: "background 150ms ease, color 120ms ease",
          }}
        >
          {recording()
            ? "Press a key…"
            : (prettyLabel(props.value ?? "") || "Unset")}
        </button>
      </div>
    </RowShell>
  );
}
