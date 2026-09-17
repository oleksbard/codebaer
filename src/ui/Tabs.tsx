import { Tabs as RT } from 'radix-ui';

export type TabItem = { value: string; label: string };

export function Tabs({ value, onValueChange, items }: { value: string; onValueChange(v: string): void; items: TabItem[] }) {
  return (
    <RT.Root value={value} onValueChange={onValueChange}>
      <RT.List className="tabs">
        {items.map((t) => (
          <RT.Trigger key={t.value} className="tab" value={t.value} aria-controls={undefined}>{t.label}</RT.Trigger>
        ))}
      </RT.List>
    </RT.Root>
  );
}
