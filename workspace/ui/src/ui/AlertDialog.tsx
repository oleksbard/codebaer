import { useState, type ReactNode } from 'react';
import { AlertDialog as RA } from 'radix-ui';
import { motion, useIsPresent } from 'motion/react';
import { Button } from './Button';
import { CopyButton } from './CopyButton';
import { lastFocusOutside, restoreFocusTo } from './focus';
import { CLOSE, StrokeIcon } from './Icon';
import { IconButton } from './IconButton';
import { DUR, EASE } from './motion';

/** Radix focuses Cancel on open, and an error has none: without this nothing in it has focus, so Tab and Enter
 *  reach the page behind it. */
function focusClose(e: Event): void {
  e.preventDefault();
  (e.currentTarget as HTMLElement | null)?.querySelector<HTMLElement>('.dialog-actions .primary')?.focus();
}

export function AlertDialog({
  title, body, confirmLabel = 'OK', cancelLabel = 'Cancel', altLabel, error = false, copy, onResult, onAlt, children,
}: {
  title: string;
  body?: string | undefined;
  confirmLabel?: string | undefined;
  cancelLabel?: string | undefined;
  /** A second answer, on the far left like macOS puts Don't Save. */
  altLabel?: string | undefined;
  error?: boolean | undefined;
  /** Shows a Copy button on the far left; true when the text reached the clipboard. */
  copy?: (() => Promise<boolean>) | undefined;
  onResult(ok: boolean): void;
  onAlt?(): void;
  /** Between the title and the body. */
  children?: ReactNode;
}) {
  const present = useIsPresent();
  const [opener] = useState(lastFocusOutside);
  return (
    <RA.Root open={present} onOpenChange={(open) => { if (!open) onResult(false); }}>
      <RA.Portal forceMount>
        <RA.Overlay asChild forceMount>
          <motion.div className="scrim" inert={!present} exit={{ opacity: 0 }}
            transition={{ duration: DUR[2], ease: EASE.std }} />
        </RA.Overlay>
        <RA.Content asChild forceMount onOpenAutoFocus={(e) => { if (error) focusClose(e); }}
          onCloseAutoFocus={restoreFocusTo(opener)}>
          <motion.div className={`dialog alert${error ? ' error' : ''}`} inert={!present}
            exit={{ opacity: 0, scale: .98 }} transition={{ duration: DUR[2], ease: EASE.std }}>
            <RA.Title className="dialog-title">{title}</RA.Title>
            {children}
            {body ? <RA.Description className="dialog-body">{body}</RA.Description> : null}
            <div className="dialog-actions">
              {copy ? <CopyButton className="copy" copy={copy} done="Copied to the clipboard" /> : null}
              {altLabel && onAlt ? <Button className="alt" onClick={onAlt}>{altLabel}</Button> : null}
              {!error && <RA.Cancel asChild><Button>{cancelLabel}</Button></RA.Cancel>}
              <RA.Action asChild>
                <Button variant="primary" onClick={(e) => { e.preventDefault(); onResult(true); }}>
                  {confirmLabel}
                </Button>
              </RA.Action>
            </div>
            {/* not an RA.Cancel: Radix keeps one Cancel ref to focus on open, and it must stay the Cancel button */}
            <IconButton label="Close" className="dialog-x" onClick={() => onResult(false)}>
              <StrokeIcon d={CLOSE} size={14} />
            </IconButton>
          </motion.div>
        </RA.Content>
      </RA.Portal>
    </RA.Root>
  );
}
