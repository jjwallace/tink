import gsap from "gsap";

export interface WordTiming {
  text: string;
  start: number;
  end: number;
}

export interface SpeakResult {
  words: WordTiming[];
  duration: number;
  originX: number;
  originY: number;
}

/**
 * Words scroll right-to-left across an arched path.
 * Starts off-screen right, scrolls in and decelerates until speech begins,
 * then tracks the spoken word at center. Exits left after speech ends.
 */
export class WordScroller {
  private container: HTMLDivElement;
  private parent: HTMLElement;
  private words: WordTiming[] = [];
  private wordEls: HTMLSpanElement[] = [];
  private wordPositions: number[] = [];
  private naturalWidths: number[] = [];
  private rafId = 0;
  private startTime = 0;
  private activeIndex = -1;
  private fontSize: number;
  private archHeight: number;
  private smoothX = 0;
  private scrollSpeed = 0;
  private exiting = false;

  private readonly maxScale = 2.2;
  private readonly minScale = 0.45;
  private readonly activeBoost = 1.1;
  private readonly wordGap = 24;

  constructor(parent: HTMLElement, fontSize = 48, archHeight = 90) {
    this.parent = parent;
    this.fontSize = fontSize;
    this.archHeight = archHeight;

    this.container = document.createElement("div");
    Object.assign(this.container.style, {
      position: "fixed",
      top: "0",
      left: "0",
      width: "0",
      height: "0",
      pointerEvents: "none",
      zIndex: "9999",
      fontFamily: "'SF Pro Display', 'Helvetica Neue', system-ui, sans-serif",
      fontSize: `${fontSize}px`,
      fontWeight: "700",
      color: "white",
      textShadow: "0 2px 16px rgba(0,0,0,0.7), 0 0 60px rgba(0,0,0,0.35)",
      opacity: "0",
      willChange: "transform",
    });

    parent.appendChild(this.container);
  }

  start(result: SpeakResult) {
    this.stop();

    this.words = result.words;
    this.container.innerHTML = "";
    this.wordEls = [];
    this.wordPositions = [];
    this.naturalWidths = [];
    this.activeIndex = -1;
    this.exiting = false;

    // Measure natural word widths
    const measurer = document.createElement("span");
    Object.assign(measurer.style, {
      position: "absolute",
      visibility: "hidden",
      whiteSpace: "nowrap",
      fontSize: `${this.fontSize}px`,
      fontWeight: "700",
      fontFamily: this.container.style.fontFamily,
    });
    document.body.appendChild(measurer);

    for (const w of this.words) {
      measurer.textContent = w.text;
      this.naturalWidths.push(measurer.offsetWidth);
    }
    document.body.removeChild(measurer);

    // Pre-compute scroll-strip positions with max-scale spacing
    let cursor = 0;
    for (let i = 0; i < this.words.length; i++) {
      const halfMax = (this.naturalWidths[i] * this.maxScale * this.activeBoost) / 2;
      cursor += halfMax;
      this.wordPositions.push(cursor);
      cursor += halfMax + this.wordGap;
    }

    // Create word elements
    const stripY = window.innerHeight / 2;
    for (let i = 0; i < this.words.length; i++) {
      const span = document.createElement("span");
      span.textContent = this.words[i].text;
      Object.assign(span.style, {
        position: "absolute",
        left: "0",
        top: "0",
        opacity: "0.2",
        willChange: "transform, opacity",
        transformOrigin: "center bottom",
        whiteSpace: "nowrap",
      });
      this.container.appendChild(span);
      this.wordEls.push(span);
      gsap.set(span, { x: this.wordPositions[i], y: stripY, scale: this.minScale });
    }

    // Start off-screen right
    const viewW = window.innerWidth;
    this.smoothX = viewW + 200;
    gsap.set(this.container, { opacity: 1 });

    // Scroll speed for exit
    if (this.wordPositions.length > 1) {
      const totalTravel =
        this.wordPositions[this.wordPositions.length - 1] - this.wordPositions[0];
      this.scrollSpeed = totalTravel / result.duration;
    } else {
      this.scrollSpeed = 200;
    }

    this.startTime = performance.now();
    this.tick();
  }

  private tick = () => {
    const elapsed = (performance.now() - this.startTime) / 1000;
    const viewCenterX = window.innerWidth / 2;
    const stripY = window.innerHeight / 2;

    // Find active word
    let newActive = -1;
    for (let i = 0; i < this.words.length; i++) {
      if (elapsed >= this.words[i].start && elapsed < this.words[i].end) {
        newActive = i;
        break;
      }
    }

    let targetX: number;

    if (this.exiting) {
      // Keep scrolling left at same speed until off-screen
      this.smoothX -= this.scrollSpeed / 60;
      targetX = this.smoothX;

      const lastScreen =
        (this.wordPositions[this.wordPositions.length - 1] ?? 0) + this.smoothX;
      if (lastScreen < -300) {
        gsap.to(this.container, {
          opacity: 0,
          duration: 0.4,
          onComplete: () => this.cleanup(),
        });
        return;
      }
    } else if (newActive >= 0) {
      // Speech active — track the spoken word to center
      const w = this.words[newActive];
      const t = Math.min(1, (elapsed - w.start) / (w.end - w.start));
      const smoothT = t * t * (3 - 2 * t); // smoothstep
      const cur = this.wordPositions[newActive];
      const next =
        newActive + 1 < this.wordPositions.length
          ? this.wordPositions[newActive + 1]
          : cur;
      const targetOffset = cur + (next - cur) * smoothT;
      targetX = viewCenterX - targetOffset;

      if (newActive !== this.activeIndex) {
        this.activeIndex = newActive;
      }
    } else if (this.words.length > 0 && elapsed >= this.words[this.words.length - 1].end) {
      // Speech ended — begin exit
      this.exiting = true;
      targetX = this.smoothX; // continue from current position
    } else {
      // Pre-speech: scroll in from the right and decelerate toward first word
      // Target is first word slightly right of center (it hasn't started yet)
      const firstWordTarget = viewCenterX - this.wordPositions[0] + viewCenterX * 0.4;
      const speechStart = this.words[0]?.start ?? 1;
      const preProgress = Math.min(1, elapsed / speechStart);
      // Ease out — fast at start, decelerating to a stop
      const eased = 1 - Math.pow(1 - preProgress, 3); // cubic ease-out

      const startX = window.innerWidth + 200;
      targetX = startX + (firstWordTarget - startX) * eased;
    }

    // Smooth lerp for buttery motion
    this.smoothX += (targetX - this.smoothX) * 0.07;

    // Per-word transforms
    for (let i = 0; i < this.wordEls.length; i++) {
      const el = this.wordEls[i];
      const screenX = this.wordPositions[i] + this.smoothX;

      const dist = (screenX - viewCenterX) / viewCenterX;
      const absDist = Math.min(Math.abs(dist), 2);

      // Arch: parabolic, peak at center
      const archY = -this.archHeight * Math.max(0, 1 - dist * dist);

      // Scale: large at center, small at edges
      const centerScale = this.maxScale - (this.maxScale - this.minScale) * absDist;
      const scale = Math.max(this.minScale, centerScale);

      // Opacity: bright at center, fading at edges
      const opacity = Math.max(0.1, 1 - absDist * 0.8);

      const isActive = i === this.activeIndex;
      const finalScale = isActive ? scale * this.activeBoost : scale;
      const finalOpacity = isActive ? 1 : opacity;

      gsap.set(el, {
        x: screenX,
        y: stripY + archY,
        scale: finalScale,
        opacity: finalOpacity,
      });
    }

    this.rafId = requestAnimationFrame(this.tick);
  };

  stop() {
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
    gsap.killTweensOf(this.container);
    for (const el of this.wordEls) {
      gsap.killTweensOf(el);
    }
  }

  private cleanup() {
    this.stop();
    this.container.innerHTML = "";
    this.wordEls = [];
    this.wordPositions = [];
    this.naturalWidths = [];
    this.activeIndex = -1;
    this.exiting = false;
  }

  destroy() {
    this.stop();
    this.container.remove();
  }
}
