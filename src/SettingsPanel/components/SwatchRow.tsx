import { For } from "solid-js";
import { RowShell } from "./RowShell";

/** Small round color swatches for palette-style rows. Active swatch
 *  gets a dark ring; hover nudges the scale via CSS transition (no
 *  GSAP needed for this many elements). */
export function SwatchRow(props: {
  label: string;
  hint: string;
  options: readonly { value: string; label: string }[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <RowShell label={props.label} hint={props.hint}>
      <div style={{ display: "flex", gap: "5px" }}>
        <For each={props.options as { value: string; label: string }[]}>
          {(opt) => {
            const isActive = () => props.value === opt.value;
            return (
              <button
                onClick={() => props.onChange(opt.value)}
                title={opt.label}
                style={{
                  width: "18px",
                  height: "18px",
                  "border-radius": "50%",
                  border: isActive()
                    ? "2px solid var(--text-primary)"
                    : "1px solid var(--control-border)",
                  cursor: "pointer",
                  background: opt.value,
                  outline: "none",
                  padding: "0",
                  "box-shadow": isActive()
                    ? "0 0 0 1.5px var(--edge-highlight), 0 1px 2px rgba(0,0,0,0.3)"
                    : "0 1px 1px rgba(0,0,0,0.2)",
                  transition: "transform 0.12s ease, box-shadow 0.12s ease",
                  transform: isActive() ? "scale(1.1)" : "scale(1)",
                }}
              />
            );
          }}
        </For>
      </div>
    </RowShell>
  );
}
