import { RowShell } from "./RowShell";
import { Dropdown } from "./Dropdown";

/** Row with a dropdown value — label on the left, Dropdown on the
 *  right. Used for any row with 3+ options. */
export function SelectRow(props: {
  label: string;
  hint: string;
  options: readonly { value: string; label: string }[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <RowShell label={props.label} hint={props.hint}>
      <Dropdown
        value={props.value}
        options={props.options}
        onChange={props.onChange}
        align="right"
      />
    </RowShell>
  );
}
