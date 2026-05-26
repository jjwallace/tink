import gsap from "gsap";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

interface HintEvent {
  x: number;
  y: number;
  shortcut: string;
}

/**
 * Floating hint bubble that appears near the cursor when text is selected.
 * Shows "Press PageDown to dictate" (or whatever the configured shortcut is).
 * Disappears after a few seconds or when selection is cleared.
 */
export class SelectionHint {
  private parent: HTMLElement;
  private bubble: HTMLDivElement | null = null;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  private unlisteners: UnlistenFn[] = [];

  constructor(parent: HTMLElement) {
    this.parent = parent;
  }

  async init() {
    this.unlisteners.push(
      await listen<HintEvent>("tts-hint-show", (e) => this.show(e.payload)),
      await listen("tts-hint-hide", () => this.hide()),
    );
  }

  private show(event: HintEvent) {
    // Remove previous
    this.hide();

    const label = event.shortcut
      .replace("CmdOrCtrl+", "\u2318")
      .replace("Shift+", "\u21E7")
      .replace("PageDown", "Page \u2193")
      .replace("PageUp", "Page \u2191");

    this.bubble = document.createElement("div");
    this.bubble.innerHTML = `<span style="opacity:0.6">press</span> <strong>${label}</strong> <span style="opacity:0.6">to read aloud</span>`;
    Object.assign(this.bubble.style, {
      position: "fixed",
      left: `${event.x + 12}px`,
      top: `${event.y - 40}px`,
      padding: "6px 14px",
      borderRadius: "8px",
      background: "rgba(20, 20, 30, 0.88)",
      border: "1px solid rgba(255,255,255,0.1)",
      boxShadow: "0 4px 20px rgba(0,0,0,0.5)",
      fontFamily: "'SF Pro Text', -apple-system, system-ui, sans-serif",
      fontSize: "13px",
      fontWeight: "400",
      color: "rgba(255,255,255,0.85)",
      whiteSpace: "nowrap",
      pointerEvents: "none",
      zIndex: "99998",
      opacity: "0",
      transform: "translateY(6px)",
    });

    this.parent.appendChild(this.bubble);

    gsap.to(this.bubble, {
      opacity: 1,
      y: 0,
      duration: 0.25,
      ease: "power2.out",
    });

    // Auto-hide after 4 seconds
    this.hideTimer = setTimeout(() => this.hide(), 4000);
  }

  hide() {
    if (this.hideTimer) {
      clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
    if (this.bubble) {
      const el = this.bubble;
      this.bubble = null;
      gsap.to(el, {
        opacity: 0,
        y: -6,
        duration: 0.2,
        onComplete: () => el.remove(),
      });
    }
  }

  async destroy() {
    for (const u of this.unlisteners) u();
    this.unlisteners = [];
    this.hide();
  }
}
