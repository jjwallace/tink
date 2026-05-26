/**
 * Unified particle pool. One engine for the whole app.
 *
 * Callers: creature (mother + tentacles + companions via emit on each tip
 * and companion head), voice anchor (edge drizzle while drag/held), STT
 * word cloud (trail behind flying words). All render from the same pool
 * so the visual language is consistent.
 *
 * Physics: small damping each tick, configurable wind/gravity, life
 * decays at 1/75 per tick (~1.25 s at 60 fps). Oldest particle gets
 * evicted when the pool is full (ring-buffer head).
 *
 * State is module-local. Emitting is fire-and-forget; rendering is done
 * by iterating live particles via `forEachLive(cb)`. Physics advances
 * on a single rAF loop owned by this module, so it keeps ticking even
 * when no single consumer is mounted.
 */

const MAX_PARTICLES = 4000;

// Hot state — typed arrays, zero-GC on emit/tick.
const px = new Float32Array(MAX_PARTICLES);
const py = new Float32Array(MAX_PARTICLES);
const pvx = new Float32Array(MAX_PARTICLES);
const pvy = new Float32Array(MAX_PARTICLES);
const plife = new Float32Array(MAX_PARTICLES);
let head = 0;

// Optional global force fields. Creature tunes these from its store each
// frame via setField; other consumers can leave them at zero.
let wind = 0;
let gravity = 0;

/**
 * Set the global wind + gravity force fields applied to every particle
 * on each tick. Small numbers — they're scaled 0.06× internally. Caller
 * is expected to write once per frame if they're changing.
 */
export function setField(w: number, g: number): void {
  wind = w;
  gravity = g;
}

/**
 * Spawn a particle at (x, y) with a velocity influence (vx, vy). The
 * velocity is scaled down and jittered so emitters don't have to
 * worry about over-injecting momentum — emit a dozen in a burst and
 * they'll spread naturally.
 */
export function emit(x: number, y: number, vx: number, vy: number): void {
  const i = head % MAX_PARTICLES;
  head++;
  px[i] = x;
  py[i] = y;
  const j = 0.35;
  pvx[i] = vx * 0.25 + (Math.random() * 2 - 1) * j;
  pvy[i] = vy * 0.25 + (Math.random() * 2 - 1) * j;
  plife[i] = 1;
}

/**
 * Iterate all live particles. Callback gets (x, y, alpha, life) where
 * alpha is life² for quadratic fade, life is raw [0..1]. Safe to call
 * many times per frame — doesn't advance physics.
 */
export function forEachLive(
  cb: (x: number, y: number, alpha: number, life: number) => void,
): void {
  for (let i = 0; i < MAX_PARTICLES; i++) {
    const life = plife[i];
    if (life <= 0) continue;
    cb(px[i], py[i], life * life, life);
  }
}

/** Diagnostic: how many particles are currently alive. */
export function countLive(): number {
  let c = 0;
  for (let i = 0; i < MAX_PARTICLES; i++) if (plife[i] > 0) c++;
  return c;
}

// Physics tick — advances velocity, position, life for every particle.
// Called once per frame by the module-owned rAF loop below so consumers
// only have to emit and render. Ticking from rAF (not from any single
// consumer) means physics keeps running even when the creature is
// unmounted or the voice anchor is torn down.
function tick(): void {
  for (let i = 0; i < MAX_PARTICLES; i++) {
    if (plife[i] <= 0) continue;
    pvx[i] += wind * 0.06;
    pvy[i] += gravity * 0.06;
    pvx[i] *= 0.97;
    pvy[i] *= 0.97;
    px[i] += pvx[i];
    py[i] += pvy[i];
    plife[i] -= 1 / 75;
    if (plife[i] <= 0) plife[i] = 0;
  }
}

function loop() {
  tick();
  requestAnimationFrame(loop);
}

// Start the physics loop once at module load. Browsers pause rAF when
// the tab is hidden — that's the right behaviour, particles freeze in
// place until focus returns.
if (typeof requestAnimationFrame !== "undefined") {
  requestAnimationFrame(loop);
}
