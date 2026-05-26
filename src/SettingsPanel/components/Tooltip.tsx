import { createSignal, Show } from "solid-js";
import { FONT } from "../theme";

/** Inline help icon — renders a small "?" badge that pops a tooltip on
 *  hover. Used as the trailing element of every row label. */
export function Tooltip(props: { text: string }) {
  const [show, setShow] = createSignal(false);

  return (
    <span
      style={{
        display: "inline-flex",
        "align-items": "center",
        "justify-content": "center",
        width: "13px",
        height: "13px",
        "border-radius": "50%",
        background: show()
          ? "color-mix(in srgb, var(--text-primary) 18%, transparent)"
          : "color-mix(in srgb, var(--text-primary) 8%, transparent)",
        color: show() ? "var(--text-primary)" : "var(--text-muted)",
        "font-size": "9px",
        "font-weight": "700",
        "font-family": FONT,
        cursor: "help",
        "flex-shrink": "0",
        position: "relative",
      }}
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
    >
      ?
      <Show when={show()}>
        <div
          style={{
            position: "absolute",
            left: "18px",
            top: "50%",
            transform: "translateY(-50%)",
            background: "rgba(30,32,36,0.95)",
            "border-radius": "6px",
            padding: "7px 10px",
            "font-size": "11px",
            "font-weight": "400",
            "font-family": FONT,
            color: "rgba(255,255,255,0.9)",
            "line-height": "1.4",
            width: "220px",
            "pointer-events": "none",
            "z-index": "10",
            "text-transform": "none",
            "letter-spacing": "0",
            "white-space": "normal",
            "box-shadow": "0 4px 14px rgba(0,0,0,0.35)",
          }}
        >
          {props.text}
        </div>
      </Show>
    </span>
  );
}
