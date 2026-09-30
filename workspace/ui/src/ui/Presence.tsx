import type { ReactNode } from 'react';
import { AnimatePresence } from 'motion/react';

/** Lets `app/` and features (which cannot import `motion`) give a list of children an exit: each needs a
 *  stable key and an `exit` prop somewhere inside it (`Dialog`, `AlertDialog`, `ui/List`'s `Row`/`Section`,
 *  `ui/Pop`). `initial={false}` so a first mount with existing children (a dialog on open, a queue on load)
 *  never replays their entrance; `mode="popLayout"` lets siblings with their own `layout` close up while an
 *  exiting one is still fading. */
export function Presence({ children, mode }: { children: ReactNode; mode?: 'sync' | 'popLayout' | 'wait' }) {
  return <AnimatePresence initial={false} {...(mode ? { mode } : {})}>{children}</AnimatePresence>;
}
