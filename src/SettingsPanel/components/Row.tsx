import type { SettingRowDef } from "../types";
import { SelectRow } from "./SelectRow";
import { ToggleRow } from "./ToggleRow";
import { SwatchRow } from "./SwatchRow";

/** Dispatch a row definition to the correct control based on option
 *  count + key. 2 options → toggle. vfx_color → swatches. Otherwise →
 *  dropdown. */
export function Row(props: {
  row: SettingRowDef;
  value: string;
  onChange: (v: string) => void;
}) {
  const { row } = props;
  if (row.key === "vfx_color") {
    return (
      <SwatchRow
        label={row.label}
        hint={row.hint}
        options={row.options}
        value={props.value}
        onChange={props.onChange}
      />
    );
  }
  if (row.options.length === 2) {
    return (
      <ToggleRow
        label={row.label}
        hint={row.hint}
        options={row.options}
        value={props.value}
        onChange={props.onChange}
      />
    );
  }
  return (
    <SelectRow
      label={row.label}
      hint={row.hint}
      options={row.options}
      value={props.value}
      onChange={props.onChange}
    />
  );
}
