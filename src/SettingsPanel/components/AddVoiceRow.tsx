import { Show } from "solid-js";
import { FONT, PURPLE, RED } from "../theme";

/** Inline "+ Add voice" row that lives at the bottom of the voice
 *  picker. Collapsed it's a thin "+ Add voice from Piper catalog"
 *  button; expanded it's a text input + preview link + Add button.
 *
 *  The Piper sample browser is hosted by Rhasspy; we deliberately link
 *  out instead of building an in-app player, since playing 700 voices
 *  from inside the overlay would mean shipping audio samples or
 *  proxying Rhasspy's CDN. External preview is the lighter, faster
 *  option. */
export function AddVoiceRow(props: {
  open: boolean;
  voiceId: string;
  error: string | null;
  onToggle: () => void;
  onChangeId: (v: string) => void;
  onAdd: () => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        "flex-direction": "column",
        gap: "5px",
        "margin-top": "4px",
      }}
    >
      <Show
        when={props.open}
        fallback={
          <button
            onClick={props.onToggle}
            style={{
              padding: "6px 10px",
              "border-radius": "6px",
              border: "1px dashed var(--control-border)",
              background: "transparent",
              color: "var(--text-muted)",
              "font-size": "11px",
              "font-family": FONT,
              cursor: "pointer",
              "text-align": "left",
              outline: "none",
            }}
          >
            + Add voice from Piper catalog
          </button>
        }
      >
        <div
          style={{
            display: "flex",
            "flex-direction": "column",
            gap: "6px",
            padding: "8px 10px",
            "border-radius": "6px",
            border: "1px solid var(--control-border)",
            background: "var(--control-bg)",
          }}
        >
          <div
            style={{
              "font-size": "10px",
              "font-family": FONT,
              color: "var(--text-muted)",
              "text-transform": "uppercase",
              "letter-spacing": "0.5px",
            }}
          >
            Add voice from Piper catalog
          </div>
          <input
            value={props.voiceId}
            onInput={(e) => props.onChangeId(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") props.onAdd();
              else if (e.key === "Escape") props.onToggle();
            }}
            placeholder="e.g. en_GB-cori-high"
            spellcheck={false}
            autocapitalize="off"
            autocomplete="off"
            style={{
              padding: "6px 8px",
              "border-radius": "4px",
              border: "1px solid var(--control-border)",
              background: "var(--input-bg, var(--control-bg))",
              color: "var(--text-primary)",
              "font-size": "12px",
              "font-family": FONT,
              outline: "none",
              width: "100%",
              "box-sizing": "border-box",
            }}
          />
          <Show when={props.error}>
            <div
              style={{
                "font-size": "10px",
                color: RED,
                "font-family": FONT,
              }}
            >
              {props.error}
            </div>
          </Show>
          <div
            style={{
              display: "flex",
              "align-items": "center",
              "justify-content": "space-between",
              gap: "8px",
            }}
          >
            <a
              href="https://rhasspy.github.io/piper-samples/"
              target="_blank"
              rel="noopener noreferrer"
              style={{
                "font-size": "10px",
                color: PURPLE,
                "font-family": FONT,
                "text-decoration": "none",
              }}
            >
              ▶ Preview voices on rhasspy.github.io
            </a>
            <div style={{ display: "flex", gap: "5px" }}>
              <button
                onClick={props.onToggle}
                style={{
                  padding: "3px 9px",
                  "border-radius": "4px",
                  border: "1px solid var(--control-border)",
                  background: "var(--control-bg)",
                  color: "var(--text-secondary)",
                  "font-size": "10px",
                  "font-weight": "600",
                  "font-family": FONT,
                  cursor: "pointer",
                  outline: "none",
                }}
              >
                Cancel
              </button>
              <button
                onClick={props.onAdd}
                style={{
                  padding: "3px 9px",
                  "border-radius": "4px",
                  border: `1px solid color-mix(in srgb, ${PURPLE} 50%, var(--control-border))`,
                  background: `color-mix(in srgb, ${PURPLE} 25%, var(--control-bg))`,
                  color: PURPLE,
                  "font-size": "10px",
                  "font-weight": "600",
                  "font-family": FONT,
                  cursor: "pointer",
                  outline: "none",
                }}
              >
                Add &amp; download
              </button>
            </div>
          </div>
        </div>
      </Show>
    </div>
  );
}
