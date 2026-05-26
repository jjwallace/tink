import { createSignal, createEffect, Show } from "solid-js";
import { FONT, RED } from "../theme";

/** Accordion section. Starts collapsed by default. Persists open/closed
 *  per section title in localStorage so user state survives reloads.
 *
 *  `alertOpen` forces the section open and paints a red accent — used to
 *  surface model-config sections when the active model isn't downloaded.
 *  The user can still collapse manually; the override re-opens on
 *  re-render when the condition is still true. */
export function SectionBox(props: {
  title: string;
  children: any;
  defaultOpen?: boolean;
  alertOpen?: boolean;
}) {
  const storageKey = `settings-section-${props.title}`;
  const initialOpen = (() => {
    if (props.alertOpen) return true;
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved !== null) return saved === "1";
    } catch {
      /* ignore */
    }
    return props.defaultOpen ?? false;
  })();
  const [open, setOpen] = createSignal(initialOpen);

  // React to alertOpen flipping on — e.g. when the user removes the
  // active model. Don't auto-close when the alert clears, so the user's
  // last explicit state is respected.
  createEffect(() => {
    if (props.alertOpen) setOpen(true);
  });

  const toggle = () => {
    const next = !open();
    setOpen(next);
    try {
      localStorage.setItem(storageKey, next ? "1" : "0");
    } catch {
      /* ignore */
    }
  };

  const isAlert = () => !!props.alertOpen;

  return (
    <div
      style={{
        "margin-bottom": "8px",
        "border-radius": "4px",
        background: "var(--well-bg)",
        border: isAlert()
          ? `2px solid ${RED}`
          : "2px solid var(--section-header-border)",
        overflow: "hidden",
      }}
    >
      <div
        onClick={toggle}
        style={{
          padding: "5px 10px",
          "font-size": "10px",
          "font-weight": "600",
          color: isAlert() ? RED : "var(--text-secondary)",
          "font-family": FONT,
          "text-transform": "uppercase",
          "letter-spacing": "1.2px",
          "border-bottom": open() ? "1px solid var(--section-header-border)" : "none",
          background: "transparent",
          cursor: "pointer",
          "user-select": "none",
          display: "flex",
          "align-items": "center",
          "justify-content": "space-between",
        }}
      >
        <span>
          {props.title}
          {isAlert() ? " — model missing" : ""}
        </span>
        <span
          style={{
            "font-size": "9px",
            color: "var(--text-muted)",
            transform: open() ? "rotate(90deg)" : "rotate(0deg)",
            transition: "transform 0.2s ease",
            display: "inline-block",
          }}
        >
          ▶
        </span>
      </div>
      <Show when={open()}>
        <div style={{ padding: "6px 10px" }}>{props.children}</div>
      </Show>
    </div>
  );
}
