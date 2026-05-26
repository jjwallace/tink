import { FONT, ACTIVE_COLOR } from "../theme";
import type { AllSettings } from "../types";
import { Dropdown } from "./Dropdown";

/** Paired toggle + sound picker in a single compact row. Used by the
 *  Sounds section so the enable/disable lives inline with the sound
 *  selector rather than stacking into two separate rows per sound.
 *  Picker fades to half-opacity when the sound is disabled. */
export function SoundSubRow(props: {
  label: string;
  enabledKey: string;
  soundKey: string;
  options: readonly { value: string; label: string }[];
  settings: AllSettings | null;
  onUpdate: (key: string, value: string) => void;
}) {
  const enabled = () => {
    const s = props.settings;
    if (!s) return true;
    return Boolean((s as unknown as Record<string, unknown>)[props.enabledKey]);
  };
  const soundValue = () => {
    const s = props.settings;
    if (!s) return "";
    return String(
      (s as unknown as Record<string, unknown>)[props.soundKey] ?? "",
    );
  };
  return (
    <div
      style={{
        display: "flex",
        "align-items": "center",
        gap: "8px",
        padding: "4px 2px",
      }}
    >
      <button
        onClick={() =>
          props.onUpdate(props.enabledKey, enabled() ? "false" : "true")
        }
        style={{
          width: "28px",
          height: "16px",
          "border-radius": "8px",
          border: "1px solid var(--control-border)",
          background: enabled() ? ACTIVE_COLOR : "var(--control-bg)",
          position: "relative",
          cursor: "pointer",
          outline: "none",
          padding: "0",
          "flex-shrink": "0",
          transition: "background 0.15s ease",
        }}
      >
        <span
          style={{
            position: "absolute",
            top: "1px",
            left: enabled() ? "13px" : "1px",
            width: "12px",
            height: "12px",
            "border-radius": "50%",
            background: "#fff",
            transition: "left 0.15s cubic-bezier(0.4,0,0.2,1)",
          }}
        />
      </button>
      <span
        style={{
          "font-family": FONT,
          "font-size": "12px",
          color: "var(--text-primary)",
          "min-width": "70px",
          opacity: enabled() ? 1 : 0.5,
        }}
      >
        {props.label}
      </span>
      <div
        style={{
          "flex-grow": "1",
          display: "flex",
          "justify-content": "flex-end",
        }}
      >
        <Dropdown
          value={soundValue()}
          options={props.options}
          onChange={(v) => props.onUpdate(props.soundKey, v)}
          disabled={!enabled()}
          minWidth="110px"
          align="right"
        />
      </div>
    </div>
  );
}
