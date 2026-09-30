import type { ReactElement, Ref } from 'react';
import { ContextMenu as RC } from 'radix-ui';
import { inertOnClose, keepFocus } from './focus';

export type MenuItem = { label: string; onSelect(): void };

/** `ref` reaches the trigger's rendered child (`asChild`): `AnimatePresence`'s `popLayout` clones a ref onto
 *  its direct child to give it `position: absolute` for the exit, and that child is this component wherever a
 *  row or a rail tile is wrapped in a `ContextMenu`. Without forwarding it here, that clone lands on a plain
 *  function component that drops it, and the exiting element never gets positioned. */
export function ContextMenu(
  { items, children, ref }: { items: MenuItem[]; children: ReactElement; ref?: Ref<HTMLElement> },
) {
  return (
    <RC.Root>
      <RC.Trigger asChild ref={ref}>{children}</RC.Trigger>
      <RC.Portal>
        <RC.Content className="menu" ref={inertOnClose} onCloseAutoFocus={keepFocus}>
          {items.map((it) => (
            <RC.Item key={it.label} className="menu-item" onSelect={it.onSelect}>{it.label}</RC.Item>
          ))}
        </RC.Content>
      </RC.Portal>
    </RC.Root>
  );
}
