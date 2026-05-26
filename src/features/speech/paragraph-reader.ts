import gsap from "gsap";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface WordTiming {
  text: string;
  start: number;
  end: number;
}

export interface OpenEvent {
  sentences: string[];
  display: string;
  mouseX: number;
  mouseY: number;
}

export interface SentenceEvent {
  index: number;
  words: WordTiming[];
  duration: number;
}

interface Bubble {
  el: HTMLDivElement;
  wordEls: HTMLSpanElement[];
  words: WordTiming[];
  startTime: number;
  active: boolean;
  done: boolean; // finished reading, shrinking
}

// ─── Shared style injection ───
let styleInjected = false;
function injectStyle() {
  if (styleInjected) return;
  const s = document.createElement("style");
  s.textContent = `.tts-panel::-webkit-scrollbar{display:none}@keyframes tts-spin{to{transform:rotate(360deg)}}`;
  document.head.appendChild(s);
  styleInjected = true;
}

/**
 * Unified TTS display renderer.
 * Supports three modes: bubbles, scroll, paragraph.
 */
export class ParagraphReader {
  private container: HTMLDivElement;
  private parent: HTMLElement;
  private baseFontSize: number;
  private isOpen = false;
  private mode = "bubbles";
  private unlisteners: UnlistenFn[] = [];
  private escHandler: ((e: KeyboardEvent) => void) | null = null;
  private rafId = 0;
  private lastFrame = 0;

  // ── Bubbles state ──
  private bubbles: Bubble[] = [];
  private spawnY = 0;
  private readonly floatSpeed = 28;
  private readonly activeFontSize = 28;
  private readonly doneFontSize = 16;

  // ── Scroll state (teleprompter ribbon) ──
  private scrollStrip: HTMLDivElement | null = null;
  private scrollWordEls: HTMLSpanElement[] = [];
  private scrollWords: WordTiming[] = [];
  private scrollActiveIndex = -1;
  private scrollSmoothX = 0;
  private scrollStartTime = 0;
  private scrollExiting = false;
  private scrollSpeed = 200;
  private scrollPhase: "enter" | "read" | "exit" = "enter";
  private scrollSmoothScale = 0.7;

  // ── Paragraph state ──
  private panel: HTMLDivElement | null = null;
  private paraWordEls: HTMLSpanElement[] = [];
  private paraSentenceEls: HTMLDivElement[] = [];
  private paraSentenceWords: HTMLSpanElement[][] = [];
  private paraActiveWord = -1;
  private paraActiveSentence = -1;
  private paraSentenceStartTime = 0;
  private paraCurrentWords: WordTiming[] = [];
  private paraSmoothScrollY = 0;
  private paraRevealedSentences = 0;
  private spinner: HTMLDivElement | null = null;

  constructor(parent: HTMLElement, fontSize = 22) {
    this.parent = parent;
    this.baseFontSize = fontSize;
    injectStyle();

    this.container = document.createElement("div");
    Object.assign(this.container.style, {
      position: "fixed",
      inset: "0",
      pointerEvents: "none",
      zIndex: "99999",
    });
    parent.appendChild(this.container);
  }

  async init() {
    this.unlisteners.push(
      await listen<OpenEvent>("tts-open", (e) => this.onOpen(e.payload)),
      await listen<SentenceEvent>("tts-sentence", (e) => this.onSentence(e.payload)),
      await listen("tts-done", () => this.onDone()),
      await listen<string>("tts-display-mode", (e) => { this.mode = e.payload; }),
      await listen("tts-escape", () => this.close()),
    );
  }

  // ════════════════════════════════════════════
  //  OPEN — route to the right mode
  // ════════════════════════════════════════════

  private onOpen(event: OpenEvent) {
    if (event.display) this.mode = event.display;
    if (this.isOpen) this.forceClose();
    this.isOpen = true;

    this.escHandler = (e: KeyboardEvent) => { if (e.key === "Escape") this.close(); };
    window.addEventListener("keydown", this.escHandler);

    if (this.mode === "bubbles") this.openBubbles(event);
    else if (this.mode === "scroll") this.openScroll();
    else if (this.mode === "paragraph") this.openParagraph(event);

    this.lastFrame = performance.now();
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = requestAnimationFrame(this.tick);
  }

  private onSentence(event: SentenceEvent) {
    if (!this.isOpen) return;
    if (this.mode === "bubbles") this.sentenceBubbles(event);
    else if (this.mode === "scroll") this.sentenceScroll(event);
    else if (this.mode === "paragraph") this.sentenceParagraph(event);
  }

  private onDone() {
    if (!this.isOpen) return;
    if (this.mode === "paragraph" && this.spinner) {
      gsap.to(this.spinner, { opacity: 0, duration: 0.2, onComplete: () => this.spinner?.remove() });
    }
    setTimeout(() => { if (this.isOpen) this.close(); }, 3000);
  }

  // ════════════════════════════════════════════
  //  BUBBLES MODE
  // ════════════════════════════════════════════

  private openBubbles(event: OpenEvent) {
    this.bubbles = [];
    // Spawn near the mouse position, or center of viewport
    this.spawnY = event.mouseY > 0 ? event.mouseY : window.innerHeight * 0.5;
  }

  private sentenceBubbles(event: SentenceEvent) {
    const { words } = event;

    const bubble = document.createElement("div");
    Object.assign(bubble.style, {
      position: "absolute",
      left: "50%",
      transform: "translateX(-50%) scale(1)",
      maxWidth: "70vw",
      padding: "14px 22px",
      borderRadius: "12px",
      background: "rgba(15, 15, 22, 0.9)",
      border: "1px solid rgba(255,255,255,0.07)",
      boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
      fontFamily: "'SF Pro Text', -apple-system, system-ui, sans-serif",
      fontSize: `${this.activeFontSize}px`,
      fontWeight: "500",
      lineHeight: "1.6",
      color: "rgba(255,255,255,0.88)",
      opacity: "0",
      pointerEvents: "none",
      whiteSpace: "normal",
      wordWrap: "break-word",
      transformOrigin: "center center",
      transition: "font-size 0.6s ease, padding 0.6s ease",
    });

    const wordEls: HTMLSpanElement[] = [];
    for (const w of words) {
      const span = document.createElement("span");
      span.textContent = w.text;
      Object.assign(span.style, {
        display: "inline-block",
        marginRight: "0.25em",
        opacity: "0.35",
      });
      bubble.appendChild(span);
      wordEls.push(span);
    }

    bubble.style.top = `${this.spawnY}px`;
    this.container.appendChild(bubble);
    gsap.to(bubble, { opacity: 1, duration: 0.3 });

    this.spawnY += bubble.offsetHeight + 14;
    if (this.spawnY > window.innerHeight * 0.85) this.spawnY = window.innerHeight * 0.85;

    this.bubbles.push({ el: bubble, wordEls, words, startTime: performance.now(), active: true, done: false });
  }

  private tickBubbles(dt: number, now: number) {
    const centerY = window.innerHeight * 0.45;
    for (let i = this.bubbles.length - 1; i >= 0; i--) {
      const b = this.bubbles[i];
      const currentTop = parseFloat(b.el.style.top) || 0;
      // Active bubble: slow float, clamp near center. Old bubbles: normal speed.
      const speed = b.active ? this.floatSpeed * 0.3 : this.floatSpeed;
      let newTop = currentTop - speed * dt;
      // Keep active bubble from floating above center
      if (b.active && newTop < centerY) newTop = centerY;
      b.el.style.top = `${newTop}px`;

      // Remove when off top
      if (newTop + b.el.offsetHeight < -20) {
        gsap.killTweensOf(b.el);
        b.el.remove();
        this.bubbles.splice(i, 1);
        continue;
      }

      // Fade near top
      if (newTop < 60 && !b.active) {
        b.el.style.opacity = String(Math.max(0, newTop / 60));
      }

      if (b.active) {
        const elapsed = (now - b.startTime) / 1000;
        let activeIdx = -1;
        for (let w = 0; w < b.words.length; w++) {
          if (elapsed >= b.words[w].start && elapsed < b.words[w].end) { activeIdx = w; break; }
        }

        for (let w = 0; w < b.wordEls.length; w++) {
          if (w === activeIdx) {
            b.wordEls[w].style.opacity = "1";
            b.wordEls[w].style.color = "#8bc4ff";
          } else if (b.words[w] && elapsed > b.words[w].end) {
            b.wordEls[w].style.opacity = "0.65";
            b.wordEls[w].style.color = "rgba(255,255,255,0.88)";
          } else {
            b.wordEls[w].style.opacity = "0.35";
            b.wordEls[w].style.color = "rgba(255,255,255,0.88)";
          }
        }

        // Sentence done → shrink bubble
        if (b.words.length > 0 && elapsed > b.words[b.words.length - 1].end) {
          b.active = false;
          b.done = true;
          // Shrink font, reduce padding, fade words
          b.el.style.fontSize = `${this.doneFontSize}px`;
          b.el.style.padding = "8px 14px";
          for (const el of b.wordEls) {
            el.style.opacity = "0.4";
            el.style.color = "rgba(255,255,255,0.7)";
          }
          // Fade out faster
          gsap.to(b.el, { opacity: 0, duration: 2, delay: 1.5, onComplete: () => {
            b.el.remove();
            const idx = this.bubbles.indexOf(b);
            if (idx >= 0) this.bubbles.splice(idx, 1);
          }});
        }
      }
    }

    this.spawnY -= this.floatSpeed * dt;
    if (this.spawnY < window.innerHeight * 0.3) this.spawnY = window.innerHeight * 0.3;
  }

  // ════════════════════════════════════════════
  //  SCROLL MODE (arched word scroller)
  // ════════════════════════════════════════════

  private openScroll() {
    this.scrollWordEls = [];
    this.scrollWords = [];
    this.scrollActiveIndex = -1;
    this.scrollSmoothX = window.innerWidth + 100; // start off-screen right
    this.scrollStartTime = 0;
    this.scrollExiting = false;
    this.scrollSpeed = 200;
    this.scrollPhase = "enter";
    this.scrollSmoothScale = 0.7;

    // Create the ribbon strip — a single inline-flow div that we translate X
    this.scrollStrip = document.createElement("div");
    Object.assign(this.scrollStrip.style, {
      position: "fixed",
      top: "50%",
      left: "0",
      transform: "translateY(-50%)",
      whiteSpace: "nowrap",
      display: "flex",
      alignItems: "baseline",
      gap: "0.35em",
      pointerEvents: "none",
      fontFamily: "'SF Pro Display', 'Helvetica Neue', system-ui, sans-serif",
      fontSize: "34px",
      fontWeight: "500",
      lineHeight: "1",
      color: "rgba(255,255,255,0.3)",
      textShadow: "0 2px 12px rgba(0,0,0,0.5)",
      opacity: "0",
      willChange: "transform",
    });
    this.container.appendChild(this.scrollStrip);
    gsap.to(this.scrollStrip, { opacity: 1, duration: 0.3 });
  }

  private sentenceScroll(event: SentenceEvent) {
    if (!this.scrollStrip) return;

    const timeOffset = this.scrollWords.length > 0
      ? this.scrollWords[this.scrollWords.length - 1].end + 0.3
      : 0;

    // Add a subtle separator between sentences
    if (this.scrollWordEls.length > 0) {
      const sep = document.createElement("span");
      sep.textContent = "  \u00B7  "; // centered dot
      sep.style.opacity = "0.2";
      this.scrollStrip.appendChild(sep);
    }

    for (const w of event.words) {
      this.scrollWords.push({
        text: w.text,
        start: w.start + timeOffset,
        end: w.end + timeOffset,
      });

      const span = document.createElement("span");
      span.textContent = w.text;
      Object.assign(span.style, {
        display: "inline-block",
        color: "rgba(255,255,255,0.3)",
        transition: "none",
      });
      this.scrollStrip.appendChild(span);
      this.scrollWordEls.push(span);
    }

    if (this.scrollStartTime === 0) this.scrollStartTime = performance.now();

    // Compute scroll speed based on total content
    const stripW = this.scrollStrip.scrollWidth;
    const totalDur = this.scrollWords[this.scrollWords.length - 1]?.end ?? 1;
    this.scrollSpeed = (stripW + window.innerWidth) / Math.max(totalDur, 1);
  }

  private tickScroll(dt: number, now: number) {
    if (!this.scrollStrip || this.scrollWords.length === 0) return;

    const elapsed = (now - this.scrollStartTime) / 1000;
    const viewCenterX = window.innerWidth / 2;

    // Find active word
    let newActive = -1;
    for (let i = 0; i < this.scrollWords.length; i++) {
      if (elapsed >= this.scrollWords[i].start && elapsed < this.scrollWords[i].end) {
        newActive = i;
        break;
      }
    }

    // Highlight transitions
    if (newActive !== this.scrollActiveIndex) {
      // Fade previous word back to dim
      if (this.scrollActiveIndex >= 0 && this.scrollActiveIndex < this.scrollWordEls.length) {
        gsap.to(this.scrollWordEls[this.scrollActiveIndex], {
          color: "rgba(255,255,255,0.5)", duration: 0.4, ease: "power2.out",
        });
      }
      // Highlight new word
      if (newActive >= 0 && newActive < this.scrollWordEls.length) {
        gsap.to(this.scrollWordEls[newActive], {
          color: "#8bc4ff", duration: 0.12, ease: "power2.out",
        });
      }
      this.scrollActiveIndex = newActive;
    }

    // Three-phase: fast enter → zoom in + slow read → zoom out + fast exit
    let targetX: number;
    let lerpSpeed: number;
    let targetScale: number;

    if (this.scrollExiting) {
      // PHASE 3: Zoom out + fast exit left
      this.scrollSmoothX -= this.scrollSpeed * 2.5 * dt;
      targetX = this.scrollSmoothX;
      lerpSpeed = 1;
      targetScale = 0.65;
      if (this.scrollSmoothX + this.scrollStrip.scrollWidth * this.scrollSmoothScale < -50) {
        this.close();
        return;
      }
    } else if (newActive >= 0 && newActive < this.scrollWordEls.length) {
      // PHASE 2: Zoomed in + slow tracking
      if (this.scrollPhase !== "read") this.scrollPhase = "read";
      const el = this.scrollWordEls[newActive];
      const wordCenter = el.offsetLeft + el.offsetWidth / 2;
      targetX = viewCenterX - wordCenter;
      lerpSpeed = 0.035;
      targetScale = 1.15; // zoomed in for readability
    } else if (this.scrollWords.length > 0 && elapsed >= this.scrollWords[this.scrollWords.length - 1].end) {
      // Speech done → start exit
      this.scrollExiting = true;
      this.scrollPhase = "exit";
      targetX = this.scrollSmoothX;
      lerpSpeed = 1;
      targetScale = 0.65;
    } else {
      // PHASE 1: Fast enter from right, small scale
      this.scrollPhase = "enter";
      const firstEl = this.scrollWordEls[0];
      if (firstEl) {
        const wordCenter = firstEl.offsetLeft + firstEl.offsetWidth / 2;
        targetX = viewCenterX - wordCenter;
      } else {
        targetX = viewCenterX;
      }
      lerpSpeed = 0.12;
      targetScale = 0.75; // small while flying in
    }

    // Lerp position and scale
    this.scrollSmoothX += (targetX - this.scrollSmoothX) * lerpSpeed;
    this.scrollSmoothScale += (targetScale - this.scrollSmoothScale) * 0.06;
    this.scrollStrip.style.transform = `translateY(-50%) translateX(${this.scrollSmoothX}px) scale(${this.scrollSmoothScale})`;
  }

  // ════════════════════════════════════════════
  //  PARAGRAPH MODE (panel block)
  // ════════════════════════════════════════════

  private async openParagraph(event: OpenEvent) {
    await this.setMouse(false);

    const overlay = this.container;
    overlay.style.display = "flex";
    overlay.style.alignItems = "center";
    overlay.style.justifyContent = "center";

    this.panel = document.createElement("div");
    this.panel.classList.add("tts-panel");
    Object.assign(this.panel.style, {
      position: "relative",
      width: "55vw", maxWidth: "750px", maxHeight: "60vh",
      padding: "32px 40px", borderRadius: "14px",
      background: "rgba(12, 12, 18, 0.92)",
      border: "1px solid rgba(255,255,255,0.08)",
      boxShadow: "0 16px 64px rgba(0,0,0,0.8)",
      overflowY: "auto", overflowX: "hidden",
      pointerEvents: "auto",
      fontFamily: "'SF Pro Text', -apple-system, system-ui, sans-serif",
      fontSize: `${this.baseFontSize + 8}px`, fontWeight: "400",
      lineHeight: "1.75", color: "rgba(255,255,255,0.92)",
    });

    this.paraSentenceEls = [];
    this.paraSentenceWords = [];
    this.paraRevealedSentences = 0;
    this.paraActiveWord = -1;
    this.paraActiveSentence = -1;
    this.paraSmoothScrollY = 0;

    for (const sent of event.sentences) {
      const div = document.createElement("div");
      div.style.opacity = "0";
      div.style.marginBottom = "0.4em";
      const words = sent.split(/\s+/).filter(Boolean);
      const spans: HTMLSpanElement[] = [];
      for (const w of words) {
        const span = document.createElement("span");
        span.textContent = w;
        Object.assign(span.style, { display: "inline-block", marginRight: "0.3em", opacity: "0.4" });
        div.appendChild(span);
        spans.push(span);
      }
      this.panel.appendChild(div);
      this.paraSentenceEls.push(div);
      this.paraSentenceWords.push(spans);
    }

    // Spinner
    this.spinner = document.createElement("div");
    Object.assign(this.spinner.style, {
      display: "flex", alignItems: "center", gap: "8px",
      marginTop: "16px", opacity: "0.5", fontSize: "14px", color: "rgba(255,255,255,0.6)",
    });
    this.spinner.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" style="animation:tts-spin 1s linear infinite"><circle cx="12" cy="12" r="10" fill="none" stroke="rgba(255,255,255,0.4)" stroke-width="3" stroke-dasharray="30 70" stroke-linecap="round"/></svg><span>Generating...</span>`;
    this.panel.appendChild(this.spinner);

    this.container.appendChild(this.panel);

    gsap.set(this.panel, { scale: 0.92, y: 15, opacity: 0 });
    gsap.to(this.panel, { scale: 1, y: 0, opacity: 1, duration: 0.35, ease: "power2.out" });
  }

  private sentenceParagraph(event: SentenceEvent) {
    const { index, words } = event;
    if (index < this.paraSentenceEls.length) {
      gsap.to(this.paraSentenceEls[index], { opacity: 1, duration: 0.3 });
    }
    this.paraActiveSentence = index;
    this.paraActiveWord = -1;
    this.paraCurrentWords = words;
    this.paraSentenceStartTime = performance.now();
  }

  private tickParagraph(dt: number, now: number) {
    if (this.paraActiveSentence < 0 || !this.panel) return;
    const elapsed = (now - this.paraSentenceStartTime) / 1000;
    const spans = this.paraSentenceWords[this.paraActiveSentence];
    if (!spans) return;

    let newActive = -1;
    for (let i = 0; i < this.paraCurrentWords.length; i++) {
      if (elapsed >= this.paraCurrentWords[i].start && elapsed < this.paraCurrentWords[i].end) { newActive = i; break; }
    }

    if (newActive !== this.paraActiveWord) {
      if (this.paraActiveWord >= 0 && this.paraActiveWord < spans.length) {
        gsap.to(spans[this.paraActiveWord], { opacity: 0.4, color: "rgba(255,255,255,0.92)", duration: 0.3 });
      }
      if (newActive >= 0 && newActive < spans.length) {
        gsap.to(spans[newActive], { opacity: 1, color: "#8bc4ff", duration: 0.08 });
      }
      this.paraActiveWord = newActive;
    }

    // Auto-scroll
    if (newActive >= 0 && newActive < spans.length) {
      const el = spans[newActive];
      const panelRect = this.panel.getBoundingClientRect();
      const elRect = el.getBoundingClientRect();
      const offset = (elRect.top + elRect.height / 2) - (panelRect.top + panelRect.height / 2);
      const target = this.panel.scrollTop + offset;
      this.paraSmoothScrollY += (target - this.paraSmoothScrollY) * 0.06;
      this.panel.scrollTop = Math.max(0, this.paraSmoothScrollY);
    }
  }

  // ════════════════════════════════════════════
  //  TICK — delegates to active mode
  // ════════════════════════════════════════════

  private tick = () => {
    if (!this.isOpen) return;
    const now = performance.now();
    const dt = (now - this.lastFrame) / 1000;
    this.lastFrame = now;

    if (this.mode === "bubbles") this.tickBubbles(dt, now);
    else if (this.mode === "scroll") this.tickScroll(dt, now);
    else if (this.mode === "paragraph") this.tickParagraph(dt, now);

    this.rafId = requestAnimationFrame(this.tick);
  };

  // ════════════════════════════════════════════
  //  CLOSE / CLEANUP
  // ════════════════════════════════════════════

  async close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    if (this.rafId) { cancelAnimationFrame(this.rafId); this.rafId = 0; }
    if (this.escHandler) { window.removeEventListener("keydown", this.escHandler); this.escHandler = null; }

    // Stop audio immediately
    try { await invoke("stop_speaking"); } catch {}

    // Fade everything out fast then clean up
    const allEls: HTMLElement[] = [];
    for (const b of this.bubbles) { gsap.killTweensOf(b.el); allEls.push(b.el); }
    for (const el of this.scrollWordEls) gsap.killTweensOf(el);
    if (this.scrollStrip) { gsap.killTweensOf(this.scrollStrip); allEls.push(this.scrollStrip); }
    if (this.panel) { gsap.killTweensOf(this.panel); allEls.push(this.panel); }

    if (allEls.length > 0) {
      gsap.to(allEls, {
        opacity: 0,
        duration: 0.25,
        ease: "power2.in",
        onComplete: () => {
          for (const el of allEls) el.remove();
          this.cleanupState();
        },
      });
    } else {
      this.cleanupState();
    }
  }

  private cleanupState() {
    this.bubbles = [];
    if (this.scrollStrip) { this.scrollStrip.remove(); this.scrollStrip = null; }
    this.scrollWordEls = [];
    this.scrollWords = [];
    this.scrollActiveIndex = -1;
    if (this.panel) { this.panel.remove(); this.panel = null; this.spinner = null; }
    this.container.style.display = "";
    this.container.style.alignItems = "";
    this.container.style.justifyContent = "";
    this.paraSentenceEls = [];
    this.paraSentenceWords = [];
    this.setMouse(true);
  }

  private forceClose() {
    if (this.rafId) { cancelAnimationFrame(this.rafId); this.rafId = 0; }
    for (const b of this.bubbles) { gsap.killTweensOf(b.el); b.el.remove(); }
    this.bubbles = [];
    for (const el of this.scrollWordEls) gsap.killTweensOf(el);
    if (this.scrollStrip) { this.scrollStrip.remove(); this.scrollStrip = null; }
    this.scrollWordEls = []; this.scrollWords = [];
    if (this.panel) { this.panel.remove(); this.panel = null; this.spinner = null; }
    this.container.style.display = ""; this.container.style.alignItems = ""; this.container.style.justifyContent = "";
    this.paraSentenceEls = []; this.paraSentenceWords = [];
    if (this.escHandler) { window.removeEventListener("keydown", this.escHandler); this.escHandler = null; }
    this.isOpen = false;
  }

  private async setMouse(ignore: boolean) {
    try { await getCurrentWindow().setIgnoreCursorEvents(ignore); } catch {}
  }

  async destroy() {
    for (const u of this.unlisteners) u();
    this.unlisteners = [];
    this.forceClose();
    this.container.remove();
  }
}
