/**
 * Minimal toast overlay for Tink system notices.
 * Shows a small card in the bottom-right of the transparent overlay.
 * Listens for: accessibility-needed, models-missing, model download events.
 */
import { listen } from "@tauri-apps/api/event";

interface Toast {
  id: number;
  msg: string;
  detail?: string;
  kind: "info" | "warn" | "ok";
  timer?: number;
}

let nextId = 0;
let container: HTMLDivElement | null = null;
const active = new Map<number, HTMLDivElement>();

function getContainer(): HTMLDivElement {
  if (container) return container;
  container = document.createElement("div");
  Object.assign(container.style, {
    position: "fixed",
    bottom: "24px",
    right: "24px",
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    zIndex: "99999",
    pointerEvents: "none",
    fontFamily: "'SF Pro Display', -apple-system, system-ui, sans-serif",
  } as Partial<CSSStyleDeclaration>);
  document.body.appendChild(container);
  return container;
}

function show(toast: Omit<Toast, "id">, durationMs = 6000): number {
  const id = ++nextId;
  const c = getContainer();

  const card = document.createElement("div");
  const bg = toast.kind === "warn" ? "rgba(200,80,60,0.92)"
           : toast.kind === "ok"   ? "rgba(40,160,80,0.92)"
           :                         "rgba(30,20,50,0.92)";
  const border = toast.kind === "warn" ? "rgba(255,120,100,0.5)"
               : toast.kind === "ok"   ? "rgba(80,220,120,0.4)"
               :                         "rgba(167,139,250,0.4)";

  Object.assign(card.style, {
    background: bg,
    border: `1px solid ${border}`,
    borderRadius: "10px",
    padding: "10px 14px",
    maxWidth: "280px",
    pointerEvents: "auto",
    boxShadow: "0 4px 20px rgba(0,0,0,0.5)",
    opacity: "0",
    transform: "translateX(20px)",
    transition: "opacity 0.25s, transform 0.25s",
  } as Partial<CSSStyleDeclaration>);

  const title = document.createElement("div");
  title.textContent = toast.msg;
  Object.assign(title.style, {
    fontSize: "12px",
    fontWeight: "600",
    color: "rgba(255,255,255,0.95)",
    lineHeight: "1.3",
  } as Partial<CSSStyleDeclaration>);
  card.appendChild(title);

  if (toast.detail) {
    const sub = document.createElement("div");
    sub.textContent = toast.detail;
    Object.assign(sub.style, {
      fontSize: "11px",
      color: "rgba(255,255,255,0.6)",
      marginTop: "3px",
      lineHeight: "1.4",
    } as Partial<CSSStyleDeclaration>);
    card.appendChild(sub);
  }

  c.appendChild(card);
  active.set(id, card);

  // Animate in
  requestAnimationFrame(() => {
    card.style.opacity = "1";
    card.style.transform = "translateX(0)";
  });

  const dismiss = () => {
    card.style.opacity = "0";
    card.style.transform = "translateX(20px)";
    setTimeout(() => { card.remove(); active.delete(id); }, 300);
  };

  card.addEventListener("click", dismiss);
  const t = durationMs > 0 ? setTimeout(dismiss, durationMs) as unknown as number : 0;

  return id;
}

export async function initToasts() {
  const uns: (() => void)[] = [];

  // Accessibility not granted — event emitted from hotkeys.rs install loop
  uns.push(await listen("accessibility-needed", () => {
    show({
      msg: "Accessibility Required",
      detail: "System Settings → Privacy & Security → Accessibility → add Tink and toggle ON",
      kind: "warn",
    }, 12000);
  }));

  // Models missing on startup
  uns.push(await listen<{ missing: string[] }>("models-missing", (e) => {
    const names = e.payload?.missing?.join(", ");
    if (names) {
      show({
        msg: "Downloading models…",
        detail: `${names} — this takes a moment on first launch`,
        kind: "info",
      }, 10000);
    }
  }));

  // Voice download complete
  uns.push(await listen("voice-download-complete", () => {
    show({ msg: "Voice model ready", kind: "ok" }, 3000);
  }));

  // Generic model complete (STT, summarizer)
  uns.push(await listen<{ model: string; status: string }>("model-download-progress", (e) => {
    if (e.payload?.status === "done") {
      show({ msg: `${e.payload.model} ready`, kind: "ok" }, 3000);
    }
  }));

  return () => uns.forEach((u) => u());
}
