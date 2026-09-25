import type { ReactNode } from 'react';
import { Tabs as RT } from 'radix-ui';

export type TabItem = { value: string; label: string; icon?: ReactNode };

export function Tabs({ value, onValueChange, items, vertical = false }: {
  value: string;
  onValueChange(v: string): void;
  items: TabItem[];
  vertical?: boolean;
}) {
  return (
    <RT.Root value={value} onValueChange={onValueChange} orientation={vertical ? 'vertical' : 'horizontal'}>
      <RT.List className={vertical ? 'tabs vert' : 'tabs'}>
        {items.map((t) => (
          <RT.Trigger key={t.value} className="tab" value={t.value} aria-controls={undefined}
            title={t.icon ? t.label : undefined} aria-label={t.icon ? t.label : undefined}>
            {t.icon ?? t.label}
          </RT.Trigger>
        ))}
      </RT.List>
    </RT.Root>
  );
}
