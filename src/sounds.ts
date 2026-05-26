import { Howl } from "howler";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";

const cache = new Map<string, Howl>();

/**
 * True while the user is holding push-to-talk. Start/milestone/complete
 * SFX are suppressed during this window so they don't compete with the
 * mic pickup. Record on/off chirps still play — they're the PTT UX.
 */
let isListening = false;

/**
 * Global mute gate. When true:
 *   - playSfx() and startLoopSfx() are no-ops
 *   - the start/complete/milestone Tauri-event listeners drop their plays
 *   - any sound currently playing (including loops) is faded out and
 *     stopped on the rising edge
 *
 * Toggled by the voice-anchor when work_mode flips to/from "muted".
 * Mute on the JS side is layered with Rust-side TTS gating; both must
 * be honored or the user hears one channel chirping while the other is
 * silent.
 */
let muted = false;

/** Stop every Howler instance currently in the cache. Called on PTT
 *  press to cut whatever was ringing (e.g. a late milestone chirp)
 *  before the mic opens. */
function stopAllHowlers() {
  for (const s of cache.values()) s.stop();
}

function getSound(name: string): Howl {
  let sound = cache.get(name);
  if (!sound) {
    const ext = name.startsWith("complete-bell")
      || name.startsWith("complete-sad")
      || name.startsWith("record-")
      || name.startsWith("sfx-")
      ? "mp3"
      : name.startsWith("complete-explode")
        ? "aiff"
        : "wav";
    sound = new Howl({ src: [`/assets/sfx/${name}.${ext}`], volume: 0.7 });
    cache.set(name, sound);
  }
  return sound;
}

/** Play a one-shot SFX by name. Volume defaults to 0.7; pass an
 *  override for cases where a UI chirp should sit quieter than narrator
 *  events. Safe to call from any DOM handler — Howler queues if the
 *  sound is still decoding on first call. No-op while muted. */
export function playSfx(name: string, volume?: number) {
  if (muted) return;
  const s = getSound(name);
  if (typeof volume === "number") s.volume(volume);
  s.play();
}

/** Start a looping ambient SFX with a quick fade-in. Idempotent — if
 *  the loop is already running this fades to the new target volume
 *  (so the same call can be used to ramp up while dragging). No-op
 *  while muted. */
export function startLoopSfx(
  name: string,
  targetVolume = 0.3,
  fadeMs = 150,
) {
  if (muted) return;
  const s = getSound(name);
  s.loop(true);
  if (!s.playing()) {
    s.volume(0);
    s.play();
  }
  s.fade(s.volume(), targetVolume, fadeMs);
}

/** Fade a looping SFX out and stop it. Safe to call when the sound
 *  isn't playing — Howler is a no-op in that case. Ignores the muted
 *  flag — callers may need to stop a loop that was started before the
 *  mute was applied. */
export function stopLoopSfx(name: string, fadeMs = 150) {
  const s = getSound(name);
  if (!s.playing()) return;
  const startVol = s.volume() as number;
  s.fade(startVol, 0, fadeMs);
  // Stop after the fade completes so the buffer doesn't keep ticking
  // at zero volume forever (and so the next start can begin from a
  // clean state).
  setTimeout(() => {
    if (s.volume() === 0) s.stop();
  }, fadeMs + 30);
}

/** Toggle the global mute. Idempotent on the same value. On the
 *  rising edge (becoming muted), every currently-playing cached sound
 *  is faded to silence and stopped — that includes ambient loops like
 *  the anchor orb hover. After this call, playSfx / startLoopSfx /
 *  the start/complete/milestone Tauri-event listeners all no-op until
 *  setMuted(false) is called. */
export function setMuted(b: boolean) {
  if (muted === b) return;
  muted = b;
  if (b) {
    for (const s of cache.values()) {
      if (!s.playing()) continue;
      const startVol = s.volume() as number;
      s.fade(startVol, 0, 150);
      // Stop after the fade completes so muting doesn't leave silent
      // sounds ticking forever in the audio context.
      setTimeout(() => {
        if (s.volume() === 0) s.stop();
      }, 180);
    }
  }
}

/** Read the current mute state. Used by callers that want their
 *  per-call volume math to know whether playback would actually be
 *  audible — but most code should just call playSfx and let it
 *  self-gate. */
export function isMuted() {
  return muted;
}

/** Preload common sounds so first play is instant. */
export function preload() {
  getSound("start-quite");
  getSound("complete-accomplish");
  getSound("complete-bell");
  // Preload the record on/off pair — otherwise the first press (and
  // especially the first release, which fires ~200 ms after press) has
  // a visible decode delay as Howler parses the mp3 buffer. Preloading
  // pays the decode cost at app start instead.
  getSound("record-on-crt");
  getSound("record-off-crt");
  // Anchor hover chirps + ambient orb loop — preload so the first
  // hover doesn't pay the mp3 decode latency.
  getSound("sfx-on");
  getSound("sfx-tape-sticky");
  getSound("sfx-orb-hover");
}

export async function initSoundEvents(): Promise<UnlistenFn[]> {
  const unlisteners: UnlistenFn[] = [];

  // Start sound — plays once when Claude begins a turn
  unlisteners.push(
    await listen("play-start-sound", async () => {
      if (isListening || muted) return; // suppress while user is talking or muted
      try {
        const settings = await invoke<{ start_sound: string; start_enabled: boolean }>("get_all_settings");
        if (!settings.start_enabled) return;
        getSound(settings.start_sound).play();
      } catch {
        getSound("start-quite").play();
      }
    })
  );

  // Complete sound — plays when Claude finishes a full response
  unlisteners.push(
    await listen("play-complete-sound", async () => {
      if (isListening || muted) return;
      try {
        const settings = await invoke<{ complete_sound: string; complete_enabled: boolean }>("get_all_settings");
        if (!settings.complete_enabled) return;
        getSound(settings.complete_sound).play();
      } catch {
        getSound("complete-accomplish").play();
      }
    })
  );

  // Milestone sound — plays during work (between tool calls) at lower volume
  unlisteners.push(
    await listen("play-milestone-sound", async () => {
      if (isListening || muted) return;
      try {
        const settings = await invoke<{ milestone_sound: string; milestone_enabled: boolean }>("get_all_settings");
        if (!settings.milestone_enabled) return;
        const s = getSound(settings.milestone_sound);
        s.volume(0.35); // quieter than start/complete
        s.play();
      } catch {
        const s = getSound("complete-bell");
        s.volume(0.35);
        s.play();
      }
    })
  );

  // STT record-on / record-off sounds + listening-state gate. When PTT
  // presses: flip `isListening` on FIRST so the other handlers suppress,
  // then stop any ringing work-cycle Howls, then play the record-on
  // chirp. The chirp itself isn't gated because it's the PTT UX, not
  // ambient audio.
  unlisteners.push(
    await listen<{ active: boolean }>("stt-active", async (e) => {
      const active = !!e.payload?.active;
      if (active) {
        // Order matters: set flag → stop Howls → play record-on. Other
        // handlers reading the flag now skip; Howls stopped include any
        // milestone/complete that was mid-ring; record-on starts fresh.
        isListening = true;
        stopAllHowlers();
      } else {
        isListening = false;
      }

      try {
        const settings = await invoke<{
          stt_sounds_enabled: boolean;
          stt_on_sound: string;
          stt_off_sound: string;
        }>("get_all_settings");
        if (!settings.stt_sounds_enabled) return;
        const name = active ? settings.stt_on_sound : settings.stt_off_sound;
        if (!name) return;
        const s = getSound(name);
        s.volume(0.55); // a touch quieter than work-cycle sounds
        s.play();
      } catch {
        // Safe fallback to hardcoded CRT clips if settings fetch fails.
        const s = getSound(active ? "record-on-crt" : "record-off-crt");
        s.volume(0.55);
        s.play();
      }
    })
  );

  return unlisteners;
}
