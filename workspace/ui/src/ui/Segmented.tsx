import { ToggleGroup as TG } from 'radix-ui';

/** A disabled segment shows its `title` on hover, to say why. */
export type Segment<V extends string> = { value: V; label: string; disabled?: boolean; title?: string | undefined };

/** Always holds a value: Radix reports a click on the pressed item as '', which is dropped. */
export function Segmented<V extends string>({ value, onValueChange, items, ...aria }: {
  value: V;
  onValueChange(v: V): void;
  items: Segment<V>[];
  'aria-labelledby'?: string;
  'aria-describedby'?: string;
}) {
  return (
    <TG.Root type="single" className="seg" value={value} {...aria}
      onValueChange={(v) => { const it = items.find((i) => i.value === v); if (it) onValueChange(it.value); }}>
      {items.map((i) => (
        <TG.Item key={i.value} className="seg-item" value={i.value} disabled={i.disabled ?? false} title={i.title}>
          {i.label}
        </TG.Item>
      ))}
    </TG.Root>
  );
}
