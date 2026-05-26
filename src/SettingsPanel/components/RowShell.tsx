import { FONT } from "../theme";
import { Tooltip } from "./Tooltip";

/** Shared row shell: label + tooltip on the left, control slot on the
 *  right. Compact 24px control height, minimal vertical rhythm. Used
 *  by every typed row component (ToggleRow, SelectRow, SwatchRow,
 *  HotkeyCaptureRow, SoundSubRow). */
export function RowShell(props: {
  label: string;
  hint: string;
  children: any;
}) {
  return (
    <div
      style={{
        display: "flex",
        "align-items": "center",
        "justify-content": "space-between",
        gap: "10px",
        "min-height": "26px",
        padding: "3px 0",
      }}
    >
      <div
        style={{
          display: "flex",
          "align-items": "center",
          gap: "6px",
          flex: "1",
          "min-width": "0",
        }}
      >
        <span
          style={{
            "font-size": "12px",
            "font-weight": "500",
            color: "var(--text-primary)",
            "font-family": FONT,
            "white-space": "nowrap",
            overflow: "hidden",
            "text-overflow": "ellipsis",
          }}
        >
          {props.label}
        </span>
        <Tooltip text={props.hint} />
      </div>
      <div
        style={{ display: "flex", "align-items": "center", "flex-shrink": "0" }}
      >
        {props.children}
      </div>
    </div>
  );
}
