import { onMount, onCleanup } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { BubbleEffect, defaultBubbleConfig, type BubbleConfig, BubbleTrailEffect, defaultBubbleTrailConfig, type BubbleTrailConfig } from "./features/ambient-vfx/bubbles";
import { ParagraphReader } from "./features/speech/paragraph-reader";
import { SelectionHint } from "./features/speech/selection-hint";
import { SttDisplay } from "./features/speech/stt-display";
import SettingsPanel from "./SettingsPanel";
import { EdgeFlash } from "./features/ambient-vfx/edge-flash";
import { FlowParticles } from "./features/ambient-vfx/flow-particles";
import { PixelStream } from "./features/ambient-vfx/pixel-stream";
import { SineWaves } from "./features/speech/sine-waves";
import { AudioTentacles } from "./features/audio-tentacles";
import { preload as preloadSounds, initSoundEvents, playSfx, startLoopSfx, stopLoopSfx, setMuted } from "./sounds";
import {
  Creature,
  CreatureOrchestrator,
  VoiceAnchor,
  setSfxAdapter,
  type AnchorPos,
} from "@jjwallace/creature";
import "./App.css";

// Wire host-app SFX into the creature package before any VoiceAnchor is constructed.
setSfxAdapter({ playSfx, startLoopSfx, stopLoopSfx, setMuted });

function App() {
  let containerRef!: HTMLDivElement;
  let bubbles: BubbleEffect | undefined;
  let trail: BubbleTrailEffect | undefined;
  let reader: ParagraphReader | undefined;
  let hint: SelectionHint | undefined;
  let sttDisplay: SttDisplay | undefined;
  let edgeFlash: EdgeFlash | undefined;
  let flowParticles: FlowParticles | undefined;
  let pixelStream: PixelStream | undefined;
  let sineWaves: SineWaves | undefined;
  let audioTentacles: AudioTentacles | undefined;
  let burstBubbles: BubbleEffect | undefined;
  let creature: Creature | undefined;
  let creatureMount: HTMLDivElement | undefined;
  // Single state machine that owns all creature choreography decisions.
  // Created when the creature engine starts; replaces the half-dozen
  // ad-hoc creature.dispatch() sites that used to fight each other.
  let creatureOrch: CreatureOrchestrator | undefined;
  let voiceAnchor: VoiceAnchor | undefined;
  let bubbleConfig: BubbleConfig = { ...defaultBubbleConfig };
  let trailConfig: BubbleTrailConfig = { ...defaultBubbleTrailConfig };
  let bubblesActive = false;
  const unlisteners: UnlistenFn[] = [];

  let shiftHeld = false;
  let prevShift = false;
  let shiftTaps: number[] = [];

  const getMousePosition = async (): Promise<[number, number]> => {
    const [x, y, wx, wy, shift] = await invoke<[number, number, number, number, boolean]>("get_mouse_position");

    // Detect shift release (tap)
    if (prevShift && !shift) {
      const now = Date.now();
      shiftTaps.push(now);
      // Keep only taps within last 600ms
      shiftTaps = shiftTaps.filter((t) => now - t < 600);
      if (shiftTaps.length >= 3) {
        shiftTaps = [];
        toggleBubbles();
      }
    }
    prevShift = shift;
    shiftHeld = shift;

    return [x - wx, y - wy];
  };


  const toggleBubbles = () => {
    bubblesActive = !bubblesActive;
    if (bubblesActive) {
      bubbles = new BubbleEffect(containerRef, bubbleConfig);
      bubbles.start();
    } else {
      bubbles?.stopSpawning();
    }
  };

  onMount(async () => {
    // Bubble trail always runs, spawns only while shift is held
    trail = new BubbleTrailEffect(containerRef, trailConfig, getMousePosition, () => shiftHeld);
    trail.start();

    // Paragraph reader for TTS overlay (listens for its own events)
    reader = new ParagraphReader(containerRef, 22);
    await reader.init();

    // Selection hint bubble
    hint = new SelectionHint(containerRef);
    await hint.init();

    // STT display (flying words from voice input)
    sttDisplay = new SttDisplay(containerRef);
    await sttDisplay.init();

    // Edge flash VFX (CSS box-shadow, no WebGL needed)
    edgeFlash = new EdgeFlash(containerRef);
    await edgeFlash.init();

    // Flow field particles (triangles, spawn during TTS speech)
    flowParticles = new FlowParticles(containerRef);
    await flowParticles.init();

    // Pixel stream — 2×2 square pixels, fired on stt-done to escort
    // the pasted transcript from the anchor to the mouse.
    pixelStream = new PixelStream(containerRef);

    // Sine waves behind speech bubble
    sineWaves = new SineWaves(containerRef);
    await sineWaves.init();

    // Audio tentacles — radial ribbons that emerge from the anchor while
    // the push-to-talk key is held. Listens to stt-active (extend/retract)
    // and stt-amplitude (wave height).
    audioTentacles = new AudioTentacles(containerRef);
    await audioTentacles.init();

    // Pixel particles — commented out, using triangles only
    // pixelParticles = new PixelParticles(containerRef);
    // await pixelParticles.init();

    // Plan Visualizer disabled — user turned off the force-layout graph.
    // planViz = new PlanViz(containerRef);
    // await planViz.init();

    // Burst bubbles on completion
    // 1/4 size bubbles on complete
    burstBubbles = new BubbleEffect(containerRef, {
      ...defaultBubbleConfig,
      scaleMin: 0.45,
      scaleMax: 0.9,
      fps: 30,
      maxBubbles: 150,
      spawnInterval: 999999,
    });
    burstBubbles.start();
    burstBubbles.stopSpawning();

    // Fly-off / idle-return / dance state is now owned by
    // CreatureOrchestrator — see features/creature/orchestrator.ts.
    // The hooks below just notify the orchestrator; it owns timers and
    // is the only caller of creature.dispatch().
    //
    // `flewOffOnce` (read by play-start-sound for tink-spawning) lives
    // on the orchestrator (`creatureOrch?.flewOffOnce`). Same for
    // `pendingExit`. `sessionClosing` is gone — its logic is now the
    // orchestrator's "offscreen" state.

    // Inactivity safety: if no Claude-side activity fires for this long,
    // force the creature off-screen. Protects against the case where a
    // turn ended without emitting `play-complete-sound` (e.g. the
    // `tail -40` gotcha in speak-response.sh dropping a long response) —
    // without this the creature would figure-8 forever next to the idle
    // anchor. Reset on every major event below.
    const IDLE_FLYOFF_MS = 6000;
    let idleTimer: number = 0;
    // Safety-net states — only synthesize a claude-stop if the
    // orchestrator is in one of these. If she's already in an idle/
    // ambient state (orbiting, dancing, parkedTight, etc.) the
    // safety net should NOT force a fly-off — those are intentional
    // steady states. The original purpose (catch dropped
    // play-complete-sound that left her figure-8'ing forever) only
    // applies when she's "thinking" or "reading".
    const SAFETY_NET_STATES = new Set(["thinking", "reading"]);
    const resetIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idleTimer = 0;
        if (creatureOrch && SAFETY_NET_STATES.has(creatureOrch.current())) {
          creatureOrch.onClaudeStop();
        }
      }, IDLE_FLYOFF_MS) as unknown as number;
    };
    // Cleanup: piggyback on the existing unlisteners array — SolidJS
    // onCleanup can't see this closure's locals, but the unlisteners
    // array is iterated there, so registering a cleanup fn here works.
    unlisteners.push(() => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = 0;
      creatureOrch?.destroy();
    });
    unlisteners.push(
      await listen("play-complete-sound", () => {
        resetIdle();
        burstBubbles?.burst(40);
        if (voiceAnchor && flowParticles) {
          const a = voiceAnchor.current();
          flowParticles.burstToAnchor(a.x, a.y, 15);
        }
        creatureOrch?.onClaudeStop();
      })
    );
    // Enabled / disabled toggle from the tray menu or anchor pip. The
    // anchor animates itself in voice-anchor/index.ts; here we tell the
    // creature to leave or return.
    unlisteners.push(
      await listen<boolean>("enabled-changed", (ev) => {
        const enabled = ev.payload;
        if (enabled) {
          creatureOrch?.onClaudeStart();
        } else {
          creature?.dispatch({ type: "leave-screen", target: { x: 0, y: 0 } });
        }
      })
    );
    unlisteners.push(
      await listen("play-start-sound", () => {
        resetIdle();
        // Tink-spawn check BEFORE notifying the orchestrator (which
        // resets flewOffOnce to consumed-state on the next fly-off).
        const earnsTink = creatureOrch?.flewOffOnce ?? false;
        creatureOrch?.onClaudeStart();
        if (voiceAnchor && flowParticles) {
          const a = voiceAnchor.current();
          flowParticles.burstToAnchor(a.x, a.y, 15);
        }
        // Progressive tink reveal: first prompt has none, each subsequent
        // fly-off→return cycle unlocks one more companion (cap 3).
        if (earnsTink && creature && creatureOrch) {
          creature.spawnTink();
          creatureOrch.flewOffOnce = false;
        }
      })
    );

    // Sound effects via Howler.js
    preloadSounds();
    const soundUns = await initSoundEvents();
    unlisteners.push(...soundUns);

    unlisteners.push(await listen("toggle-bubbles", toggleBubbles));

    // ── Voice anchor ─────────────────────────────────────────
    // Draggable point that marks where the sine-wave + creature figure-8
    // should appear when TTS is speaking.
    {
      const s = await invoke<{ voice_anchor_x?: number; voice_anchor_y?: number }>("get_all_settings");
      voiceAnchor = new VoiceAnchor(containerRef, {
        fx: s?.voice_anchor_x ?? 0.8,
        fy: s?.voice_anchor_y ?? 0.5,
      });

      // Sine-waves snap to the new fraction instantly (they don't mind).
      // Creature uses a lerped chase so rapid drag updates don't flash/glitch —
      // the creature's task anchor eases toward the latest drag position at
      // ~12% per frame.
      let tgtX = voiceAnchor.current().x;
      let tgtY = voiceAnchor.current().y;
      let curX = tgtX;
      let curY = tgtY;
      let followRaf = 0;
      const stepFollow = () => {
        // Lerp factor controls how "snappy" the creature chases the anchor
        // on drag. 0.12 read as jittery/over-reactive; 0.04 gives a much
        // lazier drift that still catches up within ~0.5s.
        curX += (tgtX - curX) * 0.04;
        curY += (tgtY - curY) * 0.04;
        creature?.followAnchor({ x: curX, y: curY });
        if (Math.abs(tgtX - curX) + Math.abs(tgtY - curY) > 0.5) {
          followRaf = requestAnimationFrame(stepFollow);
        } else {
          followRaf = 0;
        }
      };
      const apply = (pos: AnchorPos) => {
        sineWaves?.setAnchor(pos.fx, pos.fy);
        audioTentacles?.setAnchor(pos.fx, pos.fy);
        tgtX = pos.x;
        tgtY = pos.y;
        if (!followRaf) followRaf = requestAnimationFrame(stepFollow);
      };
      voiceAnchor.onChange(apply);
      apply(voiceAnchor.current());

      // Glint — anchor polls this per-frame to draw a specular reflection
      // that tracks the mother's position. Returns null when creature
      // mode is off or she's parked off-screen; the anchor fades the
      // glint out in those cases.
      voiceAnchor.setMotherPosProvider(() => creature?.getMotherPos() ?? null);

      // Words fly into the anchor — display pulls the live position each
      // spawn, so the stream follows a dragged anchor without extra wiring.
      // Use `renderedCenter()` so words target the bob-adjusted position.
      sttDisplay?.setAnchorPosProvider(() => voiceAnchor?.renderedCenter() ?? null);

      // Tentacles also track the bob so they appear welded to the orb
      // rather than floating at a static y.
      audioTentacles?.setAnchorPosProvider(() => voiceAnchor?.renderedCenter() ?? null);

      // Sine wave follows the anchor's live bob + drag, so it's phase-
      // locked with the visible orb without any shared-formula fragility.
      sineWaves?.setAnchorPosProvider(() => voiceAnchor?.renderedCenter() ?? null);

      // While dragging: creature swims around the anchor (tight orbit).
      // On drop: creature returns to figure-8 at the new anchor.
      // Sine-waves are tied to TTS only (not drag) — they fade in on tts-open
      // and out on tts-done regardless of drag state.
      voiceAnchor.onDragStart(() => {
        creatureOrch?.onDragStart();
      });
      voiceAnchor.onDragEnd(() => {
        creatureOrch?.onDragEnd();
      });
    }

    // ── Creature mode ───────────────────────────────────────
    // Starts only when `display` setting is "creature". Reacts to Claude
    // hook events (start, stop, tool runs, notifications) via scene.react().
    async function startCreature() {
      if (creature) return;
      console.log("[creature] starting");
      // In creature mode we keep both sine-waves and flow-triangles alive —
      // they're used around the voice anchor (waves on speak, triangles
      // converge on complete).

      creatureMount = document.createElement("div");
      Object.assign(creatureMount.style, {
        position: "absolute",
        inset: "0",
        pointerEvents: "none",
        zIndex: "99997",
      });
      containerRef.appendChild(creatureMount);
      creature = new Creature();
      await creature.start(creatureMount);
      // Build the state machine that owns all choreography decisions.
      // It reads the live anchor + screen each transition so it
      // automatically tracks resizes and dragged anchors.
      creatureOrch = new CreatureOrchestrator({
        creature: () => creature,
        anchor: () => voiceAnchor?.current() ?? { x: window.innerWidth / 2, y: window.innerHeight / 2 },
        screen: () => ({ w: window.innerWidth, h: window.innerHeight }),
      });
      creatureOrch.onCreatureStarted();
      console.log("[creature] started");
    }

    async function stopCreature() {
      if (!creature) return;
      console.log("[creature] stopping", new Error("stop called from").stack);
      creatureOrch?.onCreatureStopped();
      creatureOrch = undefined;
      creature.stop();
      creature = undefined;
      if (creatureMount) {
        creatureMount.remove();
        creatureMount = undefined;
      }
      // Restore the bubbles-mode VFX.
      if (!sineWaves) {
        sineWaves = new SineWaves(containerRef);
        await sineWaves.init();
      }
      if (!flowParticles) {
        flowParticles = new FlowParticles(containerRef);
        await flowParticles.init();
      }
    }

    // Initial check — start if display is "creature" AND creature_enabled.
    // creature_enabled is a VFX-section master toggle (independent of
    // display mode) so users can opt out of the tentacle companion without
    // switching display modes.
    try {
      const initial = await invoke<{ display: string; creature_enabled?: boolean }>("get_all_settings");
      const enabled = initial?.creature_enabled ?? true;
      if (initial?.display === "creature" && enabled) await startCreature();
    } catch { /* no settings yet; ignore */ }

    // React to the creature_enabled toggle from Settings > VFX.
    unlisteners.push(
      await listen<boolean>("creature-enabled", async (e) => {
        if (e.payload) await startCreature();
        else await stopCreature();
      }),
    );

    // Ambient mouse-idle poll — only feeds boolean signal into the
    // orchestrator. The orchestrator decides whether to act on it
    // (it ignores the signal during thinking/reading/offscreen/
    // orbiting/dancing states; only re-dispatches in parkedTight ⇄
    // parkedWide). 30s threshold = "user has been idle long enough
    // that ambient figure-8 is welcome."
    const CREATURE_IDLE_MS = 30_000;
    let lastMouseX = -1;
    let lastMouseY = -1;
    let lastMouseMoveAt = Date.now();
    setInterval(async () => {
      if (!creatureOrch) return;
      try {
        const [mx, my] = await invoke<[number, number, number, number, boolean]>("get_mouse_position");
        if (mx !== lastMouseX || my !== lastMouseY) {
          lastMouseX = mx;
          lastMouseY = my;
          lastMouseMoveAt = Date.now();
        }
      } catch { /* ignore */ }
      const idleFor = Date.now() - lastMouseMoveAt;
      creatureOrch.setMouseIdle(idleFor > CREATURE_IDLE_MS);
    }, 2000);

    // React to display mode changes from the settings panel
    unlisteners.push(
      await listen<string>("tts-display-mode", async (e) => {
        if (e.payload === "creature") await startCreature();
        else stopCreature();
      })
    );

    // Wire hook events to creature reactions.
    // Punctuation events (tool-run, plan-update) are suppressed while TTS is
    // reading — otherwise they yank the creature off its anchor-orbit and
    // cause a visible jump every time Claude fires a tool mid-sentence.
    let isReading = false;
    const majorEvents: Array<[string, Parameters<Creature["react"]>[0]]> = [
      ["play-start-sound",     "claude-start"],
      ["play-complete-sound",  "claude-stop"],
      ["stt-start",            "return"],
    ];
    const punctuationEvents: Array<[string, Parameters<Creature["react"]>[0]]> = [
      ["play-milestone-sound", "tool-run"],
      ["particles-burst",      "tool-run"],
      ["plan-viz-update",      "plan-update"],
    ];
    for (const [evt, kind] of majorEvents) {
      unlisteners.push(await listen(evt, (e) => creature?.react(kind, e.payload)));
    }
    for (const [evt, kind] of punctuationEvents) {
      unlisteners.push(await listen(evt, (e) => {
        if (isReading) return; // don't interrupt reading orbit
        creature?.react(kind, e.payload);
      }));
    }

    // TTS lifecycle — orchestrator handles the choreography (reading
    // state on open, parked / fly-off on done) internally, including
    // the "don't return for trailing summary" rule (handled by the
    // orchestrator's offscreen-state guard). isReading is local to
    // this file and used by the punctuation-event filter above.
    unlisteners.push(
      await listen("tts-open", () => {
        resetIdle();
        isReading = true;
        creatureOrch?.onTtsOpen();
      })
    );
    unlisteners.push(
      await listen("tts-done", () => {
        resetIdle();
        isReading = false;
        creatureOrch?.onTtsDone();
      })
    );
    unlisteners.push(
      await listen("tts-escape", () => {
        isReading = false;
        creatureOrch?.onTtsEscape();
      })
    );

    // Audio tentacles — driven by the STT event stream.
    // stt-active:true  → listening (extend straight, then squiggle)
    // stt-active:false → off       (release = retract immediately). The
    //                               intermediate "flat" state used to
    //                               hold the tentacles extended-but-
    //                               frozen during the ~250 ms decode
    //                               window, which read as a visual
    //                               pause. Retracting right away feels
    //                               responsive; the word cloud still
    //                               shows the final transcript as it
    //                               comes in.
    // stt-done         → off       (idempotent — already off by this
    //                               point, but kept for correctness).
    unlisteners.push(
      await listen<{ active: boolean }>("stt-active", (e) => {
        resetIdle();
        audioTentacles?.setState(e.payload?.active ? "listening" : "off");
        // On a new listening session, wipe any pixel-stream from the
        // previous session — pending staggered spawns + live particles.
        // Otherwise a rapid release-then-press leaves the old tail
        // overlapping the new session's UI.
        if (e.payload?.active) pixelStream?.cancel();
      })
    );
    unlisteners.push(
      await listen<{ text: string }>("stt-done", async (e) => {
        audioTentacles?.setState("off");
        // Escort the transcript from the anchor to the paste site.
        // Rust pastes wherever the OS text caret is, and the user's
        // mouse is typically still parked there from the prior click,
        // so current mouse position is a good proxy. Skip on empty
        // transcripts — nothing to escort.
        const text = e.payload?.text?.trim() ?? "";
        if (text && voiceAnchor && pixelStream) {
          try {
            const [mx, my, wx, wy] = await invoke<[number, number, number, number, boolean]>(
              "get_mouse_position"
            );
            const a = voiceAnchor.current();
            pixelStream.streamToPoint(a.x, a.y, mx - wx, my - wy);
          } catch (err) {
            console.error("[stt-done stream] failed", err);
          }
        }
      })
    );
    unlisteners.push(
      await listen<{ amplitude: number }>("stt-amplitude", (e) => {
        audioTentacles?.setAmplitude(e.payload?.amplitude ?? 0);
      })
    );
  });

  onCleanup(() => {
    bubbles?.destroy();
    trail?.destroy();
    reader?.destroy();
    hint?.destroy();
    sttDisplay?.destroy();
    edgeFlash?.destroy();
    flowParticles?.destroy();
    pixelStream?.destroy();
    sineWaves?.destroy();
    audioTentacles?.destroy();
    burstBubbles?.destroy();
    creature?.stop();
    voiceAnchor?.destroy();
    unlisteners.forEach((u) => u());
  });

  return (
    <>
      <div ref={containerRef} id="fire-container" />
      <SettingsPanel />
    </>
  );
}

export default App;
