import gsap from "gsap";

const TEXT_SHADOW =
  "0 0 10px rgba(0,0,0,1), 0 0 20px rgba(0,0,0,1), 0 0 30px rgba(0,0,0,0.8)";

export const CATEGORY_COLORS: Record<string, string> = {
  "file-created": "#6ee7a0",
  "file-modified": "#fcd34d",
  "test-passed": "#8bc4ff",
  build: "#c4b5fd",
  milestone: "#fbbf24",
};

const CATEGORY_ICONS: Record<string, string> = {
  "file-created": "✦",
  "file-modified": "✎",
  "test-passed": "✓",
  build: "◆",
  milestone: "★",
};

// Zones clustered near the graph area (bottom-center, ~75% down)
// Cards stay close — just offset from the node cluster
const ZONES = [
  { x: 0.25, y: 0.58 },
  { x: 0.75, y: 0.58 },
  { x: 0.18, y: 0.70 },
  { x: 0.82, y: 0.70 },
  { x: 0.25, y: 0.82 },
  { x: 0.75, y: 0.82 },
  { x: 0.35, y: 0.90 },
  { x: 0.65, y: 0.90 },
];

interface ActiveCard {
  el: HTMLDivElement;
  zone: number;
}

export class AchievementManager {
  private parent: HTMLElement;
  private cards: ActiveCard[] = [];
  private zoneIdx = 0;
  private queue: Array<{
    summary: string;
    category: string;
    fromX: number;
    fromY: number;
  }> = [];
  private processing = false;

  constructor(parent: HTMLElement) {
    this.parent = parent;
  }

  spawn(summary: string, category: string, fromX: number, fromY: number) {
    this.queue.push({ summary, category, fromX, fromY });
    if (!this.processing) this.processQueue();
  }

  private async processQueue() {
    this.processing = true;
    while (this.queue.length > 0) {
      const item = this.queue.shift()!;
      this.createCard(item.summary, item.category, item.fromX, item.fromY);
      if (this.queue.length > 0) {
        await new Promise((r) => setTimeout(r, 300));
      }
    }
    this.processing = false;
  }

  private createCard(
    summary: string,
    category: string,
    fromX: number,
    fromY: number,
  ) {
    const color = CATEGORY_COLORS[category] || "#ffffff";
    const icon = CATEGORY_ICONS[category] || "•";

    const zone = ZONES[this.zoneIdx % ZONES.length];
    this.zoneIdx++;

    const targetX = zone.x * window.innerWidth;
    const targetY = zone.y * window.innerHeight;

    const card = document.createElement("div");
    Object.assign(card.style, {
      position: "fixed",
      pointerEvents: "none",
      zIndex: "99996",
      display: "flex",
      alignItems: "center",
      gap: "10px",
      padding: "10px 16px",
      borderRadius: "10px",
      background: "rgba(20, 20, 30, 0.85)",
      backdropFilter: "blur(12px)",
      WebkitBackdropFilter: "blur(12px)",
      borderLeft: `3px solid ${color}`,
      boxShadow: `0 4px 24px rgba(0,0,0,0.6), 0 0 12px ${color}30`,
      maxWidth: "260px",
      fontFamily: "'SF Pro Text', -apple-system, system-ui, sans-serif",
      left: `${fromX}px`,
      top: `${fromY}px`,
    });

    // GSAP will manage transform for centering + scale
    gsap.set(card, { xPercent: -50, yPercent: -50, scale: 0 });

    const iconEl = document.createElement("span");
    Object.assign(iconEl.style, {
      fontSize: "18px",
      color,
      textShadow: `0 0 8px ${color}80`,
      flexShrink: "0",
    });
    iconEl.textContent = icon;
    card.appendChild(iconEl);

    const textEl = document.createElement("span");
    Object.assign(textEl.style, {
      fontSize: "12px",
      fontWeight: "500",
      color: "rgba(255,255,255,0.9)",
      textShadow: TEXT_SHADOW,
      lineHeight: "1.3",
    });
    textEl.textContent = summary;
    card.appendChild(textEl);

    this.parent.appendChild(card);

    // Animate: scale up from origin, drift to landing zone
    gsap.to(card, {
      left: targetX,
      top: targetY,
      scale: 1,
      duration: 0.7,
      ease: "back.out(1.4)",
    });

    // Linger, then fade + drift upward
    gsap.to(card, {
      opacity: 0,
      y: "-=30",
      duration: 1.0,
      ease: "power2.in",
      delay: 6,
      onComplete: () => {
        card.remove();
        this.cards = this.cards.filter((c) => c.el !== card);
      },
    });

    this.cards.push({ el: card, zone: this.zoneIdx - 1 });
  }

  // Summary removed — no end celebration

  resetZones() {
    this.zoneIdx = 0;
  }

  destroy() {
    for (const c of this.cards) {
      gsap.killTweensOf(c.el);
      c.el.remove();
    }
    this.cards = [];
    this.queue = [];
    this.processing = false;
  }
}
