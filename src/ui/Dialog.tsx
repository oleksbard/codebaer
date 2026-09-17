import type { ReactNode } from 'react';
import { Dialog as RD } from 'radix-ui';

export function Dialog({ open, onOpenChange, title, className, children }: {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <RD.Root open={open} onOpenChange={onOpenChange}>
      <RD.Portal>
        <RD.Overlay className="scrim" />
        <RD.Content className={['dialog', className ?? ''].filter(Boolean).join(' ')}>
          <RD.Title className="sr-only">{title}</RD.Title>
          {children}
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}
