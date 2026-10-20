import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useIsPresent } from 'motion/react';
import { DUR, EASE } from './motion';

/** A point in the viewport, and the top and bottom of the line it is on, which the card stays clear of. */
export type Anchor = { x: number; top: number; bottom: number };

const GAP = 4;
const PAD = 8;

type Hover = { onPointerEnter?: (() => void) | undefined; onPointerLeave?: (() => void) | undefined };

/** A tooltip for rich content at a place React does not render, such as a link inside a terminal. It takes the
 *  pointer, so the pointer can reach a control on it, but not the focus: what is under it keeps the keyboard. Put
 *  content that must not take the pointer either in an `inert` element. A new `id` replaces the card; a null `at`
 *  fades it out with the content it last had. */
export function HoverCard({ at, id, className, children, ...hover }: {
  at: Anchor | null;
  id: string | number;
  className?: string;
  children: ReactNode;
} & Hover) {
  return createPortal(
    <AnimatePresence initial={false}>
      {at && <Card key={id} at={at} className={className} {...hover}>{children}</Card>}
    </AnimatePresence>,
    document.body,
  );
}

function Card({ at, className, children, onPointerEnter, onPointerLeave }: {
  at: Anchor;
  className: string | undefined;
  children: ReactNode;
} & Hover) {
  const present = useIsPresent();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const below = at.bottom + GAP;
    const top = below + h > window.innerHeight - PAD && at.top - GAP - h >= PAD ? at.top - GAP - h : below;
    const left = Math.max(PAD, Math.min(at.x - 12, window.innerWidth - w - PAD));
    setPos({ top, left });
  }, [at]);
  return (
    <motion.div ref={ref} role="tooltip" inert={!present} className={`hovercard${className ? ` ${className}` : ''}`}
      onPointerEnter={onPointerEnter} onPointerLeave={onPointerLeave}
      // a pressed button would take the focus, and the keys with it, from the terminal under the card
      onMouseDown={(e) => e.preventDefault()}
      style={pos ? { top: pos.top, left: pos.left } : { top: 0, left: 0, visibility: 'hidden' }}
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      transition={{ duration: DUR[1], ease: EASE.std }}>
      {children}
    </motion.div>
  );
}
