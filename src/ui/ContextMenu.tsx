import type { ReactElement } from 'react';
import { ContextMenu as RC } from 'radix-ui';

export type MenuItem = { label: string; onSelect(): void };

export function ContextMenu({ items, children }: { items: MenuItem[]; children: ReactElement }) {
  return (
    <RC.Root>
      <RC.Trigger asChild>{children}</RC.Trigger>
      <RC.Portal>
        <RC.Content className="menu">
          {items.map((it) => (
            <RC.Item key={it.label} className="menu-item" onSelect={it.onSelect}>{it.label}</RC.Item>
          ))}
        </RC.Content>
      </RC.Portal>
    </RC.Root>
  );
}
