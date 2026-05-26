# Animation Guardrails (GSAP + Pixi)

Patterns that have earned their place after being violated. The codebase uses GSAP heavily (~300 callsites) for discrete tweens and Pixi for feature-local stages (creature, STT word cloud, pixel stream). This doc is the "things you learn the hard way" list.

## GSAP rules

### 1. Kill before you tween when state must be clean

```ts
gsap.killTweensOf(el);
gsap.to(el, { x: 0, y: 0, rotation: 0, duration: 0.3 });
```

Not killing means the new tween stacks on top of whatever's in flight — mid-air values get interpolated from the wrong starting point. Always kill before hard resets (hover enter/leave, mode changes, aborts).

### 2. Include EVERY property you want to end up at a known value

Bug: `onHoverEnter` tweened `x/y/scale/opacity` but not `rotation`. When hover fired during an in-flight throw-fan-out tween, `killTweensOf` killed the fan-out mid-interpolation and the new hover tween never touched rotation — arrows landed in the right positions but stayed slightly tilted forever. See [voice-anchor/index.ts onHoverEnter](../src/features/voice-anchor/index.ts) for the fix.

Rule: **If you call `killTweensOf(el)` and start a replacement tween, the replacement must specify every property the killed tween was controlling, or those properties freeze at their intermediate values.**

### 3. `overwrite: "auto"` for rapid-fire callers

In mousemove / every-50ms event handlers:

```ts
gsap.to(el, {
  x: newX,
  duration: 0.25,
  ease: "power2.out",
  overwrite: "auto",  // ← replaces any in-flight tween on same target+property
});
```

Without `overwrite: "auto"`, 60 mousemoves/sec create 60 stacked tweens. They queue, jank, and GSAP's default behavior is to let them all run concurrently with unpredictable composition. `overwrite: "auto"` makes each new target cleanly replace the prior one — reads as smooth chase.

### 4. `gsap.set` for instant updates, `gsap.to` for animated

Never use `gsap.to(..., { duration: 0 })` — use `gsap.set(...)`. Cheaper and no tween lifecycle overhead.

### 5. Don't fight GSAP's transform pipeline

If you set inline `transform: translate(-50%, -50%)` on an element and THEN hand it to GSAP, GSAP re-parses the transform and drops your -50% centering. Use `gsap.set(el, { xPercent: -50, yPercent: -50 })` at setup instead. See [voice-anchor/index.ts arrow init](../src/features/voice-anchor/index.ts).

### 6. Always destroy tweens you own

In `destroy()` methods, call `gsap.killTweensOf(target)` for every target the feature animates. HMR reloads will otherwise leave orphan tweens ticking on dead DOM nodes.

### 7. Timelines for sequences, parallel `to()` for concurrent

```ts
// Sequenced — use a timeline:
const tl = gsap.timeline();
tl.to(node, { alpha: 1, duration: 0.2 });
tl.to(node.scale, { x: 1.5, y: 1.5, duration: 0.4, ease: "back.out(2)" });

// Concurrent — parallel gsap.to calls:
gsap.to(node, { alpha: 1, duration: 0.3 });
gsap.to(node.scale, { x: 1.5, y: 1.5, duration: 0.3 });
```

Timelines auto-chain; parallel tweens start immediately.

### 8. Asymmetric envelopes via directional check

When amp-like values should attack fast / release slow (mic-meter envelope, voice-reactive UI):

```ts
const rising = target > current;
gsap.to(this, {
  amp: target,
  duration: rising ? 0.08 : 0.3,
  ease: rising ? "power3.out" : "power2.inOut",
});
```

See [sine-waves.ts `tts-amplitude` listener](../src/features/speech/sine-waves.ts) — mentions the `isDrop` branch.

### 9. `ease: "back.out(n)"` will overshoot

`back.out(1.5)` gives a satisfying "thwack" overshoot landing. `back.out(3)` is a cartoon bounce. Beware: if the target property has a hard bound (amplitude must not go negative, opacity must stay 0..1), the overshoot can briefly cross the bound and produce visual artifacts. Stick to `power2.out` or `sine.inOut` when bounds matter.

## Pixi rules

### 10. One Application per feature

The creature, the STT word cloud, and legacy `pixi-app.ts` each create their own `new Application()`. Don't share Pixi stages across features — they'll fight over the stage tree, render order, ticker, and event system. Own canvas, own stage, own ticker.

### 11. Pre-create the canvas, pass it to `Application.init`

```ts
const canvas = document.createElement("canvas");
canvas.style.cssText = "position:fixed;top:0;left:0;width:100vw;height:100vh;" +
  "pointer-events:none;z-index:99996;";
canvas.style.setProperty("pointer-events", "none", "important");
parent.appendChild(canvas);

const app = new Application();
await app.init({
  canvas,
  backgroundAlpha: 0,
  resizeTo: window,
  antialias: true,
  autoDensity: false,
  resolution: 1,
});
app.stage.eventMode = "none";
```

If Pixi creates its own canvas (no `canvas` option), it inherits default hit-target styling and can intercept clicks from the voice anchor. Worse, Pixi may re-style your canvas during resize and blow away inline `pointer-events: none`, so set the property both via `.style.cssText` AND `setProperty(..., "important")`.

### 12. `eventMode = "none"` on click-through stages

Any Pixi stage that should never receive pointer events should set `stage.eventMode = "none"` to short-circuit Pixi's interaction system. Belt-and-braces with canvas-level `pointer-events: none`.

### 13. Hand-managed DPR for predictable sizing

`autoDensity: false, resolution: 1` means you control scaling. Pixi's default auto-density + CSS + DPR is a footgun — numbers you write for pixel sizes silently get multiplied by 2x on retina and visuals look different per monitor.

### 14. Destroy with the options that actually clean up

```ts
app.destroy(true, { children: true, texture: true });
```

The `true` first arg removes the canvas from DOM. The second options object destroys child display objects and textures. Without both, you leak GPU memory across HMR reloads.

## GSAP × Pixi interop

### 15. GSAP tweens Pixi numeric props directly

No plugin needed for numeric properties:

```ts
gsap.to(node, { alpha: 1, duration: 0.3 });
gsap.to(node.position, { x: targetX, y: targetY, duration: 0.5 });
gsap.to(node.scale, { x: 1.5, y: 1.5, duration: 0.3 });
```

Pixi's `position`, `scale`, `skew`, `pivot` are `PointData` — treat them as regular `{x, y}` objects. Always tween both `.x` and `.y`, or tween the parent PointData object with both listed.

### 16. Don't GSAP a Pixi Container's `width`/`height`

Those are derived from children. Tweening them has undefined behavior. Tween `scale.x / scale.y` instead.

## rAF vs GSAP decision

**Use GSAP** for discrete tweens: fade in, slide to target position, rotate to angle, scale pop.

**Use raw rAF** for continuous per-frame simulation: particle physics, wave rendering, wind fields, any update loop that advances every frame. Don't do `setInterval(() => gsap.to(...))` at 60fps — that's 60 tweens/sec.

The sine-wave render loop, the shared particle pool, and creature choreography all use raw rAF. GSAP handles their fade-in/out, per-event amplitude scale tweens, and discrete state transitions.

## Performance notes

### 17. `ctx.shadowBlur` is expensive

Canvas 2D shadows are rendered per pixel of the stroke/fill. On retina, that can get costly. Used in [sine-waves.ts drawWave](../src/features/speech/sine-waves.ts) for the glow — acceptable because only a few strokes per frame. Don't shadow 50 elements.

### 18. `createLinearGradient` per frame is fine; caching is usually premature

Building a linear gradient is cheap. The sine-wave rebuilds its gradient each frame when the wave patch moves (drag tracking) and nobody notices the cost. Don't pre-cache until you measure.

### 19. Ring buffers for per-frame history

When you need "last N frames" of something (amplitude history, mouse positions, velocity samples), use a fixed `Float32Array` + head index. No allocations per frame.

## Direction invariants

When a visual must move in exactly one direction (wave traveling rightward, time advancing), stack redundant guards:

1. `Math.abs(speed)` at the consumer so the sign can't flip
2. Leading minus in the phase formula so it's structurally rightward
3. Monotonic `time += 0.008` in the advance loop so time can never decrease

All three must stay even though any one would suffice. See [sine-waves.ts drawWave direction invariant comment](../src/features/speech/sine-waves.ts) for the rationale (HMR module caching once flipped the direction; the guards caught it before it shipped).

## Checklist for a new animation feature

- [ ] Own Pixi Application (if using Pixi) with pre-created canvas + `pointer-events: none`
- [ ] `killTweensOf` before any hard-reset tween
- [ ] `overwrite: "auto"` on tweens in rapid-fire handlers (mousemove, per-frame events)
- [ ] Every tween lists ALL properties it should control through its completion
- [ ] `destroy()` kills all owned tweens and destroys all owned Pixi objects
- [ ] rAF loop for continuous simulation; GSAP for discrete state changes
- [ ] `gsap.set` (not `gsap.to` with duration 0) for instant updates
- [ ] Direction-invariant guards if motion is one-way

## Related

- [src/features/voice-anchor/index.ts](../src/features/voice-anchor/index.ts) — dense GSAP usage (drag, throw inertia, arrow choreography, bob, glint)
- [src/features/creature/renderer.ts](../src/features/creature/renderer.ts) — Pixi Application pattern
- [src/features/speech/sine-waves.ts](../src/features/speech/sine-waves.ts) — rAF rendering + GSAP state transitions, direction invariant
- [src/features/ambient-vfx/particles.ts](../src/features/ambient-vfx/particles.ts) — ring buffer pattern, module-local pool
