import { Checkbox as CB } from 'radix-ui';
import { CHECK, StrokeIcon } from './Icon';

/** Two states only: Radix also offers 'indeterminate', which nothing here can be. */
export function Checkbox({ checked, onCheckedChange, ...aria }: {
  checked: boolean;
  onCheckedChange(checked: boolean): void;
  'aria-describedby'?: string;
}) {
  return (
    <CB.Root className="check" checked={checked} onCheckedChange={(v) => onCheckedChange(v === true)} {...aria}>
      <CB.Indicator><StrokeIcon d={CHECK} size={12} /></CB.Indicator>
    </CB.Root>
  );
}
