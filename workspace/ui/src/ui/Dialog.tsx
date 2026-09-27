import type { ReactNode } from 'react';
import { Dialog as RD } from 'radix-ui';
import { CLOSE, StrokeIcon } from './Icon';
import { IconButton } from './IconButton';

export function Dialog({ open, onOpenChange, title, className, onOpenAutoFocus, children }: {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: string;
  className?: string;
  /** Radix's own: prevent it to keep the focus off the first control. */
  onOpenAutoFocus?(e: Event): void;
  children: ReactNode;
}) {
  return (
    <RD.Root open={open} onOpenChange={onOpenChange}>
      <RD.Portal>
        <RD.Overlay className="scrim" />
        <RD.Content className={['dialog', className ?? ''].filter(Boolean).join(' ')}
          {...(onOpenAutoFocus ? { onOpenAutoFocus } : {})}>
          <RD.Title className="sr-only">{title}</RD.Title>
          {children}
          {/* last, so Radix's open autofocus still lands on the dialog's own first control */}
          <RD.Close asChild>
            <IconButton label="Close" className="dialog-x"><StrokeIcon d={CLOSE} size={14} /></IconButton>
          </RD.Close>
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}
