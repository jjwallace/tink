import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import gsap from "gsap";

export interface EdgeFlashConfig {
  enabled: boolean;
  color: string;
  width: number;
  duration: number;
  peakOpacity: number;
}

export const defaultEdgeFlashConfig: EdgeFlashConfig = {
  enabled: true,
  color: "#7c3aed",
  width: 70,
  duration: 0.8,
  peakOpacity: 0.22,
};

/**
 * Edge flash VFX — CSS box-shadow inset on a fullscreen div.
 * No WebGL needed. Triggered by Tauri events.
 */
export class EdgeFlash {
  private el: HTMLDivElement;
  private config: EdgeFlashConfig;
  private unlisteners: UnlistenFn[] = [];

  constructor(container: HTMLElement, config?: Partial<EdgeFlashConfig>) {
    this.config = { ...defaultEdgeFlashConfig, ...config };

    this.el = document.createElement("div");
    Object.assign(this.el.style, {
      position: "fixed",
      top: "-10px",
      left: "-10px",
      right: "-10px",
      bottom: "-10px",
      pointerEvents: "none",
      zIndex: "99999",
      opacity: "0",
      boxShadow: this.buildShadow(this.config.color, this.config.width),
    });
    container.appendChild(this.el);
  }

  private buildShadow(color: string, spread: number): string {
    // Multiple inset shadows from all edges for a thick glow
    return [
      `inset 0 0 ${spread}px ${spread * 0.3}px ${color}`,
      `inset 0 0 ${spread * 0.5}px ${spread * 0.15}px ${color}`,
    ].join(", ");
  }

  async init() {
    this.unlisteners.push(
      await listen("play-complete-sound", () => {
        if (this.config.enabled) this.flash();
      })
    );
    this.unlisteners.push(
      await listen("edge-flash", () => {
        if (this.config.enabled) this.flash();
      })
    );
  }

  updateConfig(partial: Partial<EdgeFlashConfig>) {
    Object.assign(this.config, partial);
    this.el.style.boxShadow = this.buildShadow(this.config.color, this.config.width);
  }

  flash(color?: string) {
    if (color) {
      this.config.color = color;
      this.el.style.boxShadow = this.buildShadow(color, this.config.width);
    }

    gsap.killTweensOf(this.el);
    gsap.fromTo(this.el,
      { opacity: 0 },
      {
        opacity: this.config.peakOpacity,
        duration: this.config.duration * 0.15,
        ease: "power2.out",
        onComplete: () => {
          gsap.to(this.el, {
            opacity: 0,
            duration: this.config.duration * 0.85,
            ease: "power2.in",
          });
        },
      }
    );
  }

  destroy() {
    gsap.killTweensOf(this.el);
    for (const u of this.unlisteners) u();
    this.el.remove();
  }
}
