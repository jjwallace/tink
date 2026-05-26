import { ACTIVE_COLOR } from "../theme";
import { RowShell } from "./RowShell";

/** Compact iOS-style switch for 2-option rows. Detects ON/OFF by value
 *  rather than position so rows declared in either order render
 *  correctly. Pass options of length 2 with values like "true"/"false"
 *  or "on"/"off". */
export function ToggleRow(props: {
  label: string;
  hint: string;
  options: readonly { value: string; label: string }[];
  value: string;
  onChange: (value: string) => void;
}) {
  // Detect the ON state by value rather than position — the SECTIONS
  // data declares all boolean rows in [{On}, {Off}] order, but any row
  // using [{Off}, {On}] would otherwise render inverted.
  const onValue = () => {
    const opt = props.options.find(
      (o) => o.value === "true" || o.value === "on",
    );
    return opt?.value ?? props.options[0]?.value ?? "true";
  };
  const offValue = () => {
    const opt = props.options.find(
      (o) => o.value === "false" || o.value === "off",
    );
    return opt?.value ?? props.options[1]?.value ?? "false";
  };
  const isOn = () => props.value === onValue();
  const onLabel = () =>
    props.options.find((o) => o.value === onValue())?.label ?? "On";
  const offLabel = () =>
    props.options.find((o) => o.value === offValue())?.label ?? "Off";

  return (
    <RowShell label={props.label} hint={props.hint}>
      <button
        onClick={() => props.onChange(isOn() ? offValue() : onValue())}
        title={isOn() ? onLabel() : offLabel()}
        style={{
          width: "30px",
          height: "16px",
          "border-radius": "8px",
          border: "1px solid var(--control-border)",
          background: isOn() ? ACTIVE_COLOR : "var(--control-bg)",
          position: "relative",
          cursor: "pointer",
          outline: "none",
          padding: "0",
          transition: "background 0.15s ease",
        }}
      >
        <span
          style={{
            position: "absolute",
            top: "1px",
            left: isOn() ? "15px" : "1px",
            width: "12px",
            height: "12px",
            "border-radius": "50%",
            background: "#ffffff",
            transition: "left 0.15s cubic-bezier(0.4, 0, 0.2, 1)",
          }}
        />
      </button>
    </RowShell>
  );
}
