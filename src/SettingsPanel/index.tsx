import { createSignal, createEffect, onMount, onCleanup, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import gsap from "gsap";

import type {
  SttModelInfo,
  SummarizerModelInfo,
  VoiceSpec,
  AllSettings,
  ModelProgressEvent,
  SummarizerDownloadEvent,
  SettingRowDef,
} from "./types";
import {
  FONT,
  ACTIVE_COLOR,
  PURPLE,
  GREEN,
  RED,
  type ThemeMode,
  themeVars,
  loadTheme,
  saveTheme,
} from "./theme";
import { SUPPORTED_HOTKEYS, HOTKEY_LABEL, SECTIONS, VFX_ROWS } from "./config";


import { SectionBox } from "./components/SectionBox";
import { ToggleRow } from "./components/ToggleRow";
import { SoundSubRow } from "./components/SoundSubRow";
import { Row } from "./components/Row";
import { HotkeyCaptureRow } from "./components/HotkeyCaptureRow";
import { HotkeyTestIndicator } from "./components/HotkeyTestIndicator";
import { ModelCard } from "./components/ModelCard";
import { AddVoiceRow } from "./components/AddVoiceRow";

// ── Main Component ──

export default function SettingsPanel() {
  const [open, setOpen] = createSignal(false);
  const [theme, setTheme] = createSignal<ThemeMode>(loadTheme());
  const [settings, setSettings] = createSignal<AllSettings | null>(null);

  const toggleTheme = () => {
    const next: ThemeMode = theme() === "dark" ? "aluminum" : "dark";
    setTheme(next);
    saveTheme(next);
  };
  const [summarizerDownloads, setSummarizerDownloads] = createSignal<
    Record<string, "downloading" | "done" | "error">
  >({});
  const [sttDownloads, setSttDownloads] = createSignal<
    Record<string, "downloading" | "done" | "error">
  >({});
  const [voiceDownloads, setVoiceDownloads] = createSignal<
    Record<string, "downloading" | "done" | "error">
  >({});
  // Per-voice download progress (0..100). Populated by the
  // `voice-download-progress` Tauri event. Cleared when a download
  // finishes (complete or error). Used by ModelCard to render the
  // progress fill behind the button + pulsing border on the row.
  const [voiceProgress, setVoiceProgress] = createSignal<Record<string, number>>({});
  // Inline "+ Add voice" form state.
  const [addVoiceOpen, setAddVoiceOpen] = createSignal(false);
  const [addVoiceId, setAddVoiceId] = createSignal("");
  const [addVoiceErr, setAddVoiceErr] = createSignal<string | null>(null);
  // Lights up while the global push-to-talk hotkey is held — lets the user
  // verify their binding from the settings panel without having to open a
  // terminal and watch for STT events. Driven by the `stt-active` Tauri
  // event that Rust emits on key-down / key-up of the bound key.
  const [hotkeyActive, setHotkeyActive] = createSignal(false);

  let panelRef!: HTMLDivElement;
  let overlayRef!: HTMLDivElement;
  const unlisteners: UnlistenFn[] = [];

  // Drag state
  let isDragging = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let dragOffsetX = 0;
  let dragOffsetY = 0;

  const fetchSettings = async () => {
    try {
      const s = await invoke<AllSettings>("get_all_settings");
      // Ensure summarizer field exists (old backend compat)
      if (!s.summarizer) {
        (s as any).summarizer = { active: "smol-360m", models: [] };
      }
      setSettings(s);
    } catch (e) {
      console.error("Failed to fetch settings:", e);
      // Provide defaults so panel still opens
      setSettings({
        shortcut: "PageDown",
        voice: "lessac-fast",
        display: "bubbles",
        auto_speak: false,
        sound_mode: "both",
        stt_enabled: true,
        tts_enabled: true,
        work_mode: "focus",
        personality: "ship-computer",
        start_sound: "start-quite",
        complete_sound: "complete-accomplish",
        milestone_sound: "complete-bell",
        vfx_enabled: true,
        vfx_color: "#a78bfa",
        anchor_bob: true,
        speak_selection_enabled: true,
        speak_selection_shortcut: "PageUp",
        speak_selection_middle_click: true,
        speak_selection_mode: "summarize",
        start_enabled: true,
        milestone_enabled: true,
        complete_enabled: true,
        creature_enabled: true,
        stt_sounds_enabled: true,
        stt_on_sound: "record-on-crt",
        stt_off_sound: "record-off-crt",
        stt_text_display_enabled: true,
        tts_models: {},
        tts_voices: [],
        tts_current_voice: "en_US-lessac-low",
        stt: { active: "moonshine-tiny", models: [] },
        summarizer: { active: "smol-360m", models: [] },
      });
    }
  };

  const show = async () => {
    if (open()) return;
    await fetchSettings();
    // Tell Rust the settings panel wants cursor events; Rust's CursorCtl
    // combines this with anchor-hover state to decide click-through.
    try { await invoke("set_settings_open", { open: true }); } catch { /* ignore */ }
    setOpen(true);
    // Wait for SolidJS to render, then slide the panel in from the right edge.
    // Use fromTo for both overlay AND panel so the END state is guaranteed to
    // apply even if the tween is interrupted or gsap fails — otherwise we can
    // end up with an invisible backdrop that still captures clicks.
    await new Promise((r) => setTimeout(r, 30));
    if (overlayRef) {
      gsap.fromTo(overlayRef, { opacity: 0 }, { opacity: 1, duration: 0.2 });
    }
    if (panelRef) {
      gsap.fromTo(
        panelRef,
        { x: "100%", opacity: 1 },
        { x: 0, duration: 0.4, ease: "power3.out" },
      );
    }
  };

  const hide = async () => {
    if (!open()) return;
    if (panelRef) {
      gsap.to(panelRef, {
        x: "100%",
        duration: 0.3,
        ease: "power2.in",
        onComplete: () => {
          setOpen(false);
          dragOffsetX = 0;
          dragOffsetY = 0;
        },
      });
    } else {
      setOpen(false);
    }
    if (overlayRef) {
      gsap.to(overlayRef, { opacity: 0, duration: 0.25 });
    }
    try { await invoke("set_settings_open", { open: false }); } catch { /* ignore */ }
  };

  // Keys that are stored as booleans in AllSettings but marshalled as
  // string "true" / "false" over the settings IPC. Used for optimistic
  // local updates in updateSetting so toggles reflect instantly.
  const BOOL_KEYS = new Set([
    "auto_speak",
    "stt_enabled",
    "vfx_enabled",
    "anchor_bob",
    "speak_selection_enabled",
    "speak_selection_middle_click",
    "start_enabled",
    "milestone_enabled",
    "complete_enabled",
    "creature_enabled",
    "stt_sounds_enabled",
    "stt_text_display_enabled",
  ]);

  const updateSetting = async (key: string, value: string) => {
    const s = settings();
    if (!s) return;
    const parsed: boolean | string = BOOL_KEYS.has(key) ? value === "true" : value;
    setSettings({ ...s, [key]: parsed } as AllSettings);
    try {
      await invoke("update_setting", { key, value });
    } catch (e) {
      console.error("Failed to update setting:", e);
    }
    // Broadcast to anyone who cares (VoiceAnchor watches for anchor_bob,
    // etc.). Keeps the panel decoupled from feature components — they
    // subscribe via window.addEventListener("setting-updated", ...).
    window.dispatchEvent(
      new CustomEvent("setting-updated", { detail: { key, value: parsed } })
    );
  };

  const setActiveSummarizer = async (modelId: string) => {
    try {
      await invoke("set_summarizer_model", { modelId });
      await fetchSettings();
    } catch (e) {
      console.error("Failed to set summarizer:", e);
    }
  };

  const downloadSummarizerModel = async (modelId: string) => {
    setSummarizerDownloads((prev) => ({ ...prev, [modelId]: "downloading" }));
    try {
      await invoke("download_summarizer_model", { modelId });
    } catch (e) {
      console.error("Failed to download:", e);
      setSummarizerDownloads((prev) => ({ ...prev, [modelId]: "error" }));
    }
  };

  const setActiveStt = async (modelId: string) => {
    try {
      await invoke("set_stt_model", { modelId });
      await fetchSettings();
    } catch (e) {
      console.error("Failed to set STT model:", e);
    }
  };

  const downloadSttModel = async (modelId: string) => {
    setSttDownloads((prev) => ({ ...prev, [modelId]: "downloading" }));
    try {
      await invoke("download_stt_model", { modelId });
    } catch (e) {
      console.error("Failed to download STT model:", e);
      setSttDownloads((prev) => ({ ...prev, [modelId]: "error" }));
    }
  };

  // Drag handlers
  const onMouseDown = (e: MouseEvent) => {
    const rect = panelRef.getBoundingClientRect();
    if (e.clientY - rect.top > 50) return;
    if ((e.target as HTMLElement).tagName === "BUTTON") return;
    isDragging = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    const transform = panelRef.style.transform;
    const match = transform.match(/translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/);
    dragOffsetX = match ? parseFloat(match[1]) : 0;
    dragOffsetY = match ? parseFloat(match[2]) : 0;
    panelRef.style.cursor = "grabbing";
    e.preventDefault();
  };

  const onMouseMove = (e: MouseEvent) => {
    if (!isDragging) return;
    const dx = e.clientX - dragStartX + dragOffsetX;
    const dy = e.clientY - dragStartY + dragOffsetY;
    panelRef.style.transform = `translate(${dx}px, ${dy}px)`;
  };

  const onMouseUp = () => {
    if (!isDragging) return;
    isDragging = false;
    panelRef.style.cursor = "";
  };

  onMount(async () => {
    // Sync Rust's CursorCtl on mount — a hot-reload (Vite HMR) can re-mount
    // this component while Rust still has settings_open=true from a previous
    // session, which leaves the whole overlay interactive and steals clicks
    // from apps behind it. Panel always starts closed, so force false.
    try { await invoke("set_settings_open", { open: false }); } catch { /* ignore */ }

    unlisteners.push(await listen("open-settings", () => show()));
    // `models-missing` used to auto-open the panel on boot so the user could
    // install things, but it surprised users with a full-screen modal every
    // startup. Suppress the auto-open — if models are missing, the tray menu
    // + the model cards in Settings still let the user fix it on their own.
    // (The event still fires; we just don't react to it.)
    unlisteners.push(
      await listen<SummarizerDownloadEvent>("summarizer-download-progress", (e) => {
        setSummarizerDownloads((prev) => ({ ...prev, [e.payload.model]: e.payload.status }));
        if (e.payload.status === "done") {
          // Refresh settings to update downloaded state
          fetchSettings();
        }
      })
    );
    unlisteners.push(
      await listen<ModelProgressEvent>("stt-download-progress", (e) => {
        setSttDownloads((prev) => ({ ...prev, [e.payload.model]: e.payload.status }));
        if (e.payload.status === "done") fetchSettings();
      })
    );
    // Voice download lifecycle — Rust emits start / progress / complete / error.
    // Payloads are objects: { id }, { id, done, total, percent }, etc.
    unlisteners.push(
      await listen<{ id: string }>("voice-download-start", (e) => {
        setVoiceDownloads((prev) => ({ ...prev, [e.payload.id]: "downloading" }));
        setVoiceProgress((prev) => ({ ...prev, [e.payload.id]: 0 }));
      })
    );
    unlisteners.push(
      await listen<{ id: string; done: number; total: number; percent: number }>(
        "voice-download-progress",
        (e) => {
          setVoiceProgress((prev) => ({
            ...prev,
            [e.payload.id]: Math.max(0, Math.min(100, e.payload.percent || 0)),
          }));
        }
      )
    );
    unlisteners.push(
      await listen<{ id: string }>("voice-download-complete", (e) => {
        setVoiceDownloads((prev) => ({ ...prev, [e.payload.id]: "done" }));
        setVoiceProgress((prev) => {
          const next = { ...prev };
          delete next[e.payload.id];
          return next;
        });
        fetchSettings();
      })
    );
    unlisteners.push(
      await listen<{ id: string; error?: string }>("voice-download-error", (e) => {
        setVoiceDownloads((prev) => ({ ...prev, [e.payload.id]: "error" }));
        setVoiceProgress((prev) => {
          const next = { ...prev };
          delete next[e.payload.id];
          return next;
        });
      })
    );
    unlisteners.push(
      await listen("tts-escape", () => {
        if (open()) hide();
      })
    );

    // Hotkey test indicator — Rust emits { active: true|false } on each
    // push-to-talk press/release. Mirror straight into our signal.
    unlisteners.push(
      await listen<{ active: boolean }>("stt-active", (e) => {
        setHotkeyActive(!!e.payload?.active);
      })
    );

    // Global keyboard
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && open()) hide();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);

    onCleanup(() => {
      // Same reason as onMount: never leave Rust with settings_open=true on
      // unmount, or HMR leaves the overlay permanently interactive.
      invoke("set_settings_open", { open: false }).catch(() => {});
      unlisteners.forEach((u) => u());
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    });
  });

  const getValue = (key: string): string => {
    const s = settings();
    if (!s) return "";
    return String((s as unknown as Record<string, unknown>)[key] ?? "");
  };

  // Build the voice list from the dynamic spec array returned by the
  // backend. This now includes user-added Piper voices as well as the
  // built-ins; downloaded status comes from `tts_models[id]`.
  const voiceModels = (): SummarizerModelInfo[] => {
    const s = settings();
    if (!s) return [];
    return s.tts_voices.map((spec) => ({
      id: spec.id,
      label: spec.label,
      description:
        (spec.size_mb ? `${spec.size_mb} MB — ` : "") +
        (spec.id === "en_US-ryan-high" ? "Bright US male, ship-computer pick" : `Piper ${spec.id}`),
      downloaded: !!s.tts_models[spec.id],
    }));
  };

  const setActiveVoice = (voiceKey: string) => {
    setSettings((prev) => prev ? { ...prev, voice: voiceKey } : prev);
    invoke("update_setting", { key: "voice", value: voiceKey })
      .catch((err) => console.error("[voice-select]", err));
  };

  const downloadVoiceModel = (voiceKey: string) => {
    setVoiceDownloads((prev) => ({ ...prev, [voiceKey]: "downloading" }));
    invoke("download_voice_model", { voice: voiceKey })
      .catch((err) => {
        console.error("[voice-download]", err);
        setVoiceDownloads((prev) => ({ ...prev, [voiceKey]: "error" }));
      });
  };

  // Missing-model signals used to force-open and red-tint the three
  // model-bearing accordions. Fall back to false while settings load so
  // sections don't flash open on first render.
  const voiceMissing = () => {
    const s = settings();
    if (!s) return false;
    const active = s.tts_current_voice || s.voice;
    return !s.tts_models?.[active];
  };
  const sttMissing = () => {
    const s = settings();
    if (!s) return false;
    const active = s.stt.models.find((m) => m.id === s.stt.active);
    return !active?.downloaded;
  };
  const summarizerMissing = () => {
    const s = settings();
    if (!s) return false;
    const active = s.summarizer.models.find((m) => m.id === s.summarizer.active);
    return !active?.downloaded;
  };

  // Sound picker option lists — used by the inline Sounds section below.
  const START_OPTS = [
    { value: "start-quite", label: "Quiet" },
    { value: "start-mystery", label: "Mystery" },
  ];
  const MILESTONE_OPTS = [
    { value: "complete-bell", label: "Bell" },
    { value: "complete-sad", label: "Soft" },
    { value: "start-quite", label: "Tick" },
  ];
  const COMPLETE_OPTS = [
    { value: "complete-accomplish", label: "Accomplish" },
    { value: "complete-bell", label: "Bell" },
    { value: "complete-explode", label: "Explode" },
    { value: "complete-sad", label: "Sad" },
  ];
  // Only one record-on / record-off clip ships today (the CRT pair),
  // but the setting is a string so more variants can be dropped into
  // public/assets/sfx/ and listed here without touching the backend.
  const STT_ON_OPTS = [
    { value: "record-on-crt", label: "CRT" },
  ];
  const STT_OFF_OPTS = [
    { value: "record-off-crt", label: "CRT" },
  ];

  return (
    <Show when={open()}>
      {/* Overlay backdrop — full screen, click outside = close. Theme CSS
          vars live on this root so every nested style can read them via
          var(--x); swapping theme() re-applies the whole palette at once.
          Starts visible (opacity:1) so a missed GSAP tween can't strand the
          panel in an invisible-but-click-blocking state. The show() tween
          fades in smoothly from 0 anyway via gsap.fromTo. */}
      <div
        ref={overlayRef}
        onClick={(e) => {
          if (e.target === overlayRef) hide();
        }}
        style={{
          position: "fixed",
          inset: "0",
          background: "var(--backdrop-alpha)",
          "z-index": "100001",
          opacity: "1",
          ...themeVars(theme()),
        }}
      >
        {/* Panel — docked to right, full height, slides in via GSAP x.
            Background/text colors come from CSS custom properties set on the
            overlay root. Dismiss via backdrop click or ESC; no ✕ button. */}
        <div
          ref={panelRef}
          style={{
            position: "fixed",
            top: "0",
            right: "0",
            height: "100vh",
            width: "360px",
            background: "var(--panel-bg)",
            "background-image": "var(--panel-bg-image), var(--panel-bg)",
            padding: "16px 20px",
            "overflow-y": "auto",
            "border-left": "1px solid var(--panel-border)",
            "box-shadow":
              "-20px 0 40px rgba(0,0,0,0.4), inset 1px 0 0 var(--edge-highlight)",
            // Initial state visible — gsap.fromTo still animates from
            // translateX(100%) → 0 on show(), but if the tween is skipped
            // (HMR, gsap load race), the panel renders in place rather than
            // being stranded offscreen.
            transform: "translateX(0)",
            opacity: "1",
          }}
        >
          {/* Title strip — dark/light text on theme bg. Draggable region (the
              onMouseDown handler gates on clientY<50). */}
          <div
            style={{
              display: "flex",
              "align-items": "center",
              "justify-content": "space-between",
              "margin-bottom": "14px",
              cursor: "grab",
              "user-select": "none",
            }}
          >
            <div style={{ display: "flex", "align-items": "center", gap: "8px" }}>
              <button
                onClick={(e) => { e.stopPropagation(); hide(); }}
                title="Close settings"
                style={{
                  width: "22px",
                  height: "22px",
                  "border-radius": "4px",
                  border: "1px solid var(--control-border)",
                  background: "var(--control-bg)",
                  color: "var(--text-secondary)",
                  "font-size": "14px",
                  "line-height": "1",
                  cursor: "pointer",
                  outline: "none",
                  padding: "0",
                  display: "flex",
                  "align-items": "center",
                  "justify-content": "center",
                  "box-shadow": "inset 0 1px 0 var(--edge-highlight)",
                  "font-family": FONT,
                }}
              >
                ✕
              </button>
              <div
                style={{
                  "font-size": "16px",
                  "font-weight": "600",
                  color: "var(--text-primary)",
                  "font-family": FONT,
                  "letter-spacing": "0.3px",
                }}
              >
                Settings
              </div>
            </div>
            <div style={{ display: "flex", "align-items": "center", gap: "8px" }}>
              <button
                onClick={(e) => { e.stopPropagation(); toggleTheme(); }}
                title={`Theme: ${theme()} — click to switch`}
                style={{
                  width: "26px",
                  height: "20px",
                  "border-radius": "4px",
                  border: "1px solid var(--control-border)",
                  background: "var(--control-bg)",
                  color: "var(--text-secondary)",
                  "font-size": "11px",
                  "line-height": "1",
                  cursor: "pointer",
                  outline: "none",
                  padding: "0",
                  display: "flex",
                  "align-items": "center",
                  "justify-content": "center",
                  "box-shadow": "inset 0 1px 0 var(--edge-highlight)",
                  "font-family": FONT,
                }}
              >
                {theme() === "dark" ? "☾" : "☀"}
              </button>
              <div
                style={{
                  "font-size": "9px",
                  "font-weight": "500",
                  color: "var(--text-muted)",
                  "font-family": FONT,
                  "text-transform": "uppercase",
                  "letter-spacing": "1px",
                }}
              >
                ESC / click out
              </div>
            </div>
          </div>

          {/* Personality section hidden for now — Ship Computer is the
              only active personality. Re-expose by uncommenting this
              block (and the SECTIONS / PERSONALITY_OPTIONS data above
              it) when we reintroduce the picker.

          <For each={SECTIONS}>
            {(section) => (
              <SectionBox title={section.title} defaultOpen={true}>
                <For each={section.rows}>
                  {(row) => (
                    <Row
                      row={row}
                      value={getValue(row.key)}
                      onChange={(v) => updateSetting(row.key, v)}
                    />
                  )}
                </For>
              </SectionBox>
            )}
          </For>
          */}

          {/* ─── Model-bearing sections (TTS / STT / Summarizer) ───
              Grouped together so the user sees all LM settings in one
              visual chunk. All three default-open and auto-red if the
              active model isn't downloaded. */}

          {/* Text to Speech — TTS enable, auto-speak, hotkey, voice models. */}
          <SectionBox title="Text to Speech" defaultOpen={true} alertOpen={voiceMissing()}>
            <ToggleRow
              label="Enabled"
              hint="Master toggle for all TTS output. When off, the app stops speaking responses, selections, and mode chirps — visuals still play."
              options={[
                { value: "true", label: "On" },
                { value: "false", label: "Off" },
              ]}
              value={getValue("tts_enabled")}
              onChange={(v) => updateSetting("tts_enabled", v)}
            />
            <ToggleRow
              label="Auto-Speak"
              hint="Automatically summarize and speak agent responses after each reply."
              options={[
                { value: "true", label: "On" },
                { value: "false", label: "Off" },
              ]}
              value={getValue("auto_speak")}
              onChange={(v) => updateSetting("auto_speak", v)}
            />
            <HotkeyCaptureRow
              value={getValue("shortcut")}
              onChange={(v) => updateSetting("shortcut", v)}
            />
            <HotkeyTestIndicator active={hotkeyActive()} />
            <div style={{ display: "flex", "flex-direction": "column", gap: "5px", "margin-top": "8px" }}>
              <For each={voiceModels()}>
                {(model) => (
                  <ModelCard
                    model={model}
                    isActive={
                      model.id === settings()?.tts_current_voice ||
                      model.id === settings()?.voice
                    }
                    downloadStatus={voiceDownloads()[model.id] ?? null}
                    downloadProgress={voiceProgress()[model.id]}
                    onUse={() => setActiveVoice(model.id)}
                    onDownload={() => downloadVoiceModel(model.id)}
                  />
                )}
              </For>
              <AddVoiceRow
                open={addVoiceOpen()}
                voiceId={addVoiceId()}
                error={addVoiceErr()}
                onToggle={() => {
                  setAddVoiceOpen(!addVoiceOpen());
                  setAddVoiceErr(null);
                }}
                onChangeId={(v) => {
                  setAddVoiceId(v);
                  setAddVoiceErr(null);
                }}
                onAdd={async () => {
                  const id = addVoiceId().trim();
                  if (!id) {
                    setAddVoiceErr("Enter a Piper voice ID");
                    return;
                  }
                  try {
                    await invoke("add_custom_voice", { piperId: id });
                    setAddVoiceId("");
                    setAddVoiceOpen(false);
                    fetchSettings();
                    // Auto-trigger the download for the freshly added voice.
                    downloadVoiceModel(id);
                  } catch (err) {
                    setAddVoiceErr(String(err));
                  }
                }}
              />
            </div>
          </SectionBox>

          {/* Speech-to-Text — enable toggle, record-sound pair, model cards. */}
          <SectionBox title="Speech-to-Text" defaultOpen={true} alertOpen={sttMissing()}>
            <ToggleRow
              label="Enabled"
              hint="Push-to-talk voice input. Hold the hotkey to speak, release to paste text."
              options={[
                { value: "true", label: "On" },
                { value: "false", label: "Off" },
              ]}
              value={getValue("stt_enabled")}
              onChange={(v) => updateSetting("stt_enabled", v)}
            />
            <SoundSubRow
              label="Record On"
              enabledKey="stt_sounds_enabled"
              soundKey="stt_on_sound"
              options={STT_ON_OPTS}
              settings={settings()}
              onUpdate={updateSetting}
            />
            <SoundSubRow
              label="Record Off"
              enabledKey="stt_sounds_enabled"
              soundKey="stt_off_sound"
              options={STT_OFF_OPTS}
              settings={settings()}
              onUpdate={updateSetting}
            />
            <ToggleRow
              label="Text Cloud"
              hint="Show the flashing word-cloud visual that spawns around the anchor as your speech is transcribed. Turn off to suppress the animation — tentacles and record sounds are unaffected."
              options={[
                { value: "true", label: "On" },
                { value: "false", label: "Off" },
              ]}
              value={getValue("stt_text_display_enabled")}
              onChange={(v) => updateSetting("stt_text_display_enabled", v)}
            />
            <div style={{ display: "flex", "flex-direction": "column", gap: "5px", "margin-top": "8px" }}>
              <For each={settings()?.stt.models ?? []}>
                {(model) => (
                  <ModelCard
                    model={model}
                    isActive={model.id === settings()?.stt.active}
                    downloadStatus={sttDownloads()[model.id] ?? null}
                    onUse={() => setActiveStt(model.id)}
                    onDownload={() => downloadSttModel(model.id)}
                  />
                )}
              </For>
            </div>
          </SectionBox>

          {/* Summarizer — the on-device LLM for narration + speak-selection. */}
          <SectionBox title="Summarizer" defaultOpen={true} alertOpen={summarizerMissing()}>
            <div style={{ display: "flex", "flex-direction": "column", gap: "5px" }}>
              <For each={settings()?.summarizer.models ?? []}>
                {(model) => (
                  <ModelCard
                    model={model}
                    isActive={model.id === settings()?.summarizer.active}
                    downloadStatus={summarizerDownloads()[model.id] ?? null}
                    onUse={() => setActiveSummarizer(model.id)}
                    onDownload={() => downloadSummarizerModel(model.id)}
                  />
                )}
              </For>
            </div>
          </SectionBox>

          {/* Speak Selection — hotkey + middle-click triggers that read
              (or summarize-then-read) whatever text is currently selected
              anywhere on the system. Sits below the LM sections because it
              consumes them (TTS voice + Summarizer model). Collapsed by
              default. */}
          <SectionBox title="Speak Selection">
            <ToggleRow
              label="Enabled"
              hint="Master toggle for the speak-selection feature. When off, both the hotkey and middle-click triggers are disabled."
              options={[
                { value: "true", label: "On" },
                { value: "false", label: "Off" },
              ]}
              value={getValue("speak_selection_enabled")}
              onChange={(v) => updateSetting("speak_selection_enabled", v)}
            />
            <HotkeyCaptureRow
              label="Hotkey"
              hint="Press once with text selected to read it aloud. Supports F1–F20, PageUp/Down, Home/End, Insert/Delete, or any letter/digit with a modifier (e.g. Cmd+Shift+S)."
              value={getValue("speak_selection_shortcut")}
              onChange={(v) => updateSetting("speak_selection_shortcut", v)}
            />
            <ToggleRow
              label="Middle-Click"
              hint="Middle-mouse-button click also triggers speak-selection. Turn off if middle-click conflicts with another tool."
              options={[
                { value: "true", label: "On" },
                { value: "false", label: "Off" },
              ]}
              value={getValue("speak_selection_middle_click")}
              onChange={(v) => updateSetting("speak_selection_middle_click", v)}
            />
            <ToggleRow
              label="Mode"
              hint="Summarize runs the selected text through the on-device summarizer before speaking (1–2 sentence digest). Verbatim reads the raw selection exactly as highlighted."
              options={[
                { value: "summarize", label: "Summarize" },
                { value: "verbose", label: "Verbatim" },
              ]}
              value={getValue("speak_selection_mode")}
              onChange={(v) => updateSetting("speak_selection_mode", v)}
            />
          </SectionBox>

          {/* Sounds — three paired toggle + picker rows. Start plays when
              Claude begins, Milestone during tool calls, Complete when a
              response finishes. Each independently toggleable. */}
          <SectionBox title="Sounds">
            <SoundSubRow
              label="Start"
              enabledKey="start_enabled"
              soundKey="start_sound"
              options={START_OPTS}
              settings={settings()}
              onUpdate={updateSetting}
            />
            <SoundSubRow
              label="Milestone"
              enabledKey="milestone_enabled"
              soundKey="milestone_sound"
              options={MILESTONE_OPTS}
              settings={settings()}
              onUpdate={updateSetting}
            />
            <SoundSubRow
              label="Complete"
              enabledKey="complete_enabled"
              soundKey="complete_sound"
              options={COMPLETE_OPTS}
              settings={settings()}
              onUpdate={updateSetting}
            />
          </SectionBox>

          {/* VFX — edge flash, color, anchor bob. Closed by default. */}
          <SectionBox title="VFX">
            <For each={VFX_ROWS}>
              {(row) => (
                <Row
                  row={row}
                  value={getValue(row.key)}
                  onChange={(v) => updateSetting(row.key, v)}
                />
              )}
            </For>
          </SectionBox>
        </div>
      </div>
    </Show>
  );
}
