import { useId } from 'react';
import { ToggleGroup as TG } from 'radix-ui';
import { TabIndicator } from './Tabs';
import { Tip } from './Tip';

/** A disabled segment shows its `title` in a tip on hover, to say why. */
export type Segment<V extends string> = { value: V; label: string; disabled?: boolean; title?: string | undefined };

/** Always holds a value: Radix reports a click on the pressed item as '', which is dropped. */
export function Segmented<V extends string>({ value, onValueChange, items, ...aria }: {
  value: V;
  onValueChange(v: V): void;
  items: Segment<V>[];
  'aria-labelledby'?: string;
  'aria-describedby'?: string;
}) {
  const id = useId();
  return (
    <TG.Root type="single" className="seg" value={value} {...aria}
      onValueChange={(v) => { const it = items.find((i) => i.value === v); if (it) onValueChange(it.value); }}>
      {items.map((i) => {
        const item = (
          <TG.Item key={i.value} className="seg-item" value={i.value} disabled={i.disabled ?? false}>
            {i.value === value && <TabIndicator id={id} value={value} className="seg-ind" />}
            {i.label}
          </TG.Item>
        );
        return i.disabled && i.title
          ? <Tip key={i.value} label={i.title}><span className="seg-tip">{item}</span></Tip>
          : item;
      })}
    </TG.Root>
  );
}
