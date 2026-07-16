// Static configuration data for SettingsPanel — hotkey allowlist,
// section row definitions, etc. Pulled into its own module so the shell
// component (index.tsx) stays focused on composition.

import type { SettingRowDef, SettingsSection } from "./types";

// Bare keys the hotkey can be bound to without any modifier — the
// CGEvent tap fires on the raw keycode, so anything here must be a key
// the user is unlikely to hit during normal typing. Letters and digits
// are NOT included here on purpose; they're only accepted as part of a
// chord (Cmd+Shift+A etc.) — see `isValidChord` below.
//
// Must stay in sync with `parse_shortcut` / `key_to_keycode` in
// src-tauri/src/hotkeys.rs.
export const SUPPORTED_HOTKEYS = new Set([
  "PageUp",
  "PageDown",
  "Home",
  "End",
  "Insert",
  "Delete",
  "F1",
  "F2",
  "F3",
  "F4",
  "F5",
  "F6",
  "F7",
  "F8",
  "F9",
  "F10",
  "F11",
  "F12",
  "F13",
  "F14",
  "F15",
  "F16",
  "F17",
  "F18",
  "F19",
  "F20",
]);

export const HOTKEY_LABEL: Record<string, string> = {
  PageDown: "PageDn",
  PageUp: "PageUp",
};

/// Modifier order used when serializing chord shortcuts. Cmd first so a
/// label like "Cmd+Shift+A" reads naturally. Parsing on the Rust side
/// is order-independent.
export const MODIFIER_ORDER = ["Cmd", "Ctrl", "Alt", "Shift"] as const;

// Personality picker is currently hidden — see SettingsPanel/index.tsx
// for the gate. The data lives here so reintroducing the picker only
// needs the gate flipped, no row data to recreate.
export const SECTIONS: SettingsSection[] = [
  {
    title: "Personality",
    rows: [
      {
        label: "Voice",
        key: "personality",
        hint: "Voice personality flavoring the narration summaries. Cutie is warm plushie energy; Ship Computer is dry Hitchhiker's-Guide-flavored telemetry; Six-Seven is Gen Z brainrot; Detective is a 1940s private eye working the case; Gossipy Bestie is brunch-gossip energy; John McAfee is paranoid-founder gonzo energy; Zen is minimal, spare, stays out of your way; Drunken Sailor is a pissed-off bastard at the docks — extremely profane; Thinker just holds the thought (no checking, no guessing) while Claude does the answering.",
        options: [
          { value: "none", label: "None" },
          { value: "cutie", label: "Cutie" },
          { value: "ship-computer", label: "Ship Computer" },
          { value: "six-seven", label: "6-7 / Brainrot" },
          { value: "noir-detective", label: "Detective" },
          { value: "gossipy-bestie", label: "Gossipy Bestie" },
          { value: "mcafee", label: "John McAfee" },
          { value: "zen", label: "Zen" },
          { value: "drunken-sailor", label: "Drunken Sailor" },
          { value: "thinker", label: "Thinker" },
        ],
      },
    ],
  },
];

// VFX rows — rendered inline at the bottom of the panel rather than
// through the SECTIONS loop, so section ordering reads top-to-bottom in
// the JSX.
export const VFX_ROWS: SettingRowDef[] = [
  {
    label: "Creature",
    key: "creature_enabled",
    hint: "Show the tentacle companion that reacts to TTS and tool events. Turn off for a distraction-free overlay.",
    options: [
      { value: "true", label: "On" },
      { value: "false", label: "Off" },
    ],
  },
  {
    label: "Edge Flash",
    key: "vfx_enabled",
    hint: "Flash a color around the screen edges on completion events.",
    options: [
      { value: "true", label: "On" },
      { value: "false", label: "Off" },
    ],
  },
  {
    label: "Flash Color",
    key: "vfx_color",
    hint: "Color of the edge flash effect.",
    options: [
      { value: "#a78bfa", label: "Purple" },
      { value: "#64d8ff", label: "Cyan" },
      { value: "#4ade80", label: "Green" },
      { value: "#f97316", label: "Orange" },
      { value: "#f43f5e", label: "Rose" },
      { value: "#facc15", label: "Gold" },
    ],
  },
  {
    label: "Anchor Bob",
    key: "anchor_bob",
    hint: "Tiny idle float — the anchor drifts up and down a few pixels. Purely cosmetic.",
    options: [
      { value: "true", label: "On" },
      { value: "false", label: "Off" },
    ],
  },
];
