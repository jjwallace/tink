import { FONT } from "../theme";

/** Press-and-hold indicator for the push-to-talk hotkey. Dim dot +
 *  label when idle; glowing green dot + "LISTENING" label while the
 *  bound key is held. Driven by the `active` prop, which mirrors the
 *  Rust `stt-active` event — so this lights up iff the OS actually
 *  delivered the hotkey to the event tap, which is the real test of
 *  the binding. */
export function HotkeyTestIndicator(props: { active: boolean }) {
  return (
    <div
      style={{
        display: "flex",
        "align-items": "center",
        "justify-content": "flex-end",
        gap: "8px",
        padding: "4px 2px 2px 0",
        "font-family": FONT,
      }}
    >
      <span
        style={{
          "font-size": "10px",
          "font-weight": "600",
          "letter-spacing": "0.8px",
          "text-transform": "uppercase",
          color: props.active
            ? "rgba(120,230,160,0.95)"
            : "rgba(255,255,255,0.35)",
          transition: "color 120ms ease",
        }}
      >
        {props.active ? "Listening" : "Hold to test"}
      </span>
      <div
        style={{
          width: "10px",
          height: "10px",
          "border-radius": "50%",
          background: props.active
            ? "radial-gradient(circle at 35% 35%, rgba(180,255,200,1) 0%, rgba(70,210,120,0.95) 55%, rgba(30,140,60,0.9) 100%)"
            : "radial-gradient(circle at 35% 35%, rgba(90,90,100,0.9) 0%, rgba(40,40,50,0.9) 100%)",
          "box-shadow": props.active
            ? "0 0 10px rgba(90,230,140,0.85), 0 0 22px rgba(90,230,140,0.45), inset 0 0 3px rgba(255,255,255,0.4)"
            : "inset 0 1px 1px rgba(0,0,0,0.5)",
          transition: "background 120ms ease, box-shadow 160ms ease",
        }}
      />
    </div>
  );
}
