import { useState, type ReactNode } from 'react';
import { Dialog as RD } from 'radix-ui';
import { motion, useIsPresent } from 'motion/react';
import { lastFocusOutside, restoreFocusTo } from './focus';
import { CLOSE, StrokeIcon } from './Icon';
import { IconButton } from './IconButton';
import { DUR, EASE } from './motion';

export function Dialog({ open, onOpenChange, title, className, onOpenAutoFocus, children }: {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: string;
  className?: string;
  /** Radix's own: prevent it to keep the focus off the first control. */
  onOpenAutoFocus?(e: Event): void;
  children: ReactNode;
}) {
  // true outside a Presence (the palette): open passes through unchanged, and present never turns false
  // to trigger the exit below
  const present = useIsPresent();
  // captured once per mount, which a registered overlay gets fresh each time it opens (isOpen() going false
  // drops it from Presence's children, and AnimatePresence only remounts it once the exit has fully removed it)
  const [opener] = useState(lastFocusOutside);
  return (
    <RD.Root open={open && present} onOpenChange={onOpenChange}>
      <RD.Portal forceMount>
        <RD.Overlay asChild forceMount>
          <motion.div className="scrim" inert={!present} exit={{ opacity: 0 }}
            transition={{ duration: DUR[2], ease: EASE.std }} />
        </RD.Overlay>
        <RD.Content asChild forceMount onCloseAutoFocus={restoreFocusTo(opener)}
          {...(onOpenAutoFocus ? { onOpenAutoFocus } : {})}>
          <motion.div className={['dialog', className ?? ''].filter(Boolean).join(' ')} inert={!present}
            exit={{ opacity: 0, scale: .98 }} transition={{ duration: DUR[2], ease: EASE.std }}>
            <RD.Title className="sr-only">{title}</RD.Title>
            {children}
            {/* last, so Radix's open autofocus still lands on the dialog's own first control */}
            <RD.Close asChild>
              <IconButton label="Close" className="dialog-x"><StrokeIcon d={CLOSE} size={14} /></IconButton>
            </RD.Close>
          </motion.div>
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}
