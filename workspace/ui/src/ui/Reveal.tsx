import type { ReactNode } from 'react';
import { AnimatePresence, motion, useIsPresent, type TargetAndTransition } from 'motion/react';
import { DUR, EASE } from './motion';

type Kind = 'fade' | 'rise' | 'pop';

const VARIANT: Record<Kind, { hidden: TargetAndTransition; shown: TargetAndTransition }> = {
  fade: { hidden: { opacity: 0 }, shown: { opacity: 1 } },
  rise: { hidden: { opacity: 0, y: 4 }, shown: { opacity: 1, y: 0 } },
  pop: { hidden: { opacity: 0, scale: .9 }, shown: { opacity: 1, scale: 1 } },
};

/** UI that appears after an action or a background event, not the page it opens with: `initial={false}` means
 *  a remount (a tab switch) shows `when`'s current state at once, with no replay. Children come from props,
 *  since whatever store field `when` reads is already cleared while this plays its exit. */
export function Reveal({ when, as = 'div', className, kind = 'fade', children }: {
  when: boolean;
  as?: 'div' | 'span';
  className?: string;
  kind?: Kind;
  children: ReactNode;
}) {
  return (
    <AnimatePresence initial={false}>
      {when && <RevealContent as={as} className={className} kind={kind}>{children}</RevealContent>}
    </AnimatePresence>
  );
}

/** Split out from `Reveal` so `useIsPresent` sees the `AnimatePresence` above it, not the one Reveal itself
 *  renders: going inert while it exits keeps a stale descendant (a row `ui/List`'s key handler reads from the
 *  live DOM) from acting as if its fading section were still current. */
function RevealContent({ as, className, kind, children }: {
  as: 'div' | 'span';
  className?: string | undefined;
  kind: Kind;
  children: ReactNode;
}) {
  const present = useIsPresent();
  const Tag = as === 'span' ? motion.span : motion.div;
  const { hidden, shown } = VARIANT[kind];
  return (
    <Tag className={className} initial={hidden} animate={shown} exit={hidden} inert={!present}
      transition={{ duration: DUR[2], ease: EASE.std }}>
      {children}
    </Tag>
  );
}
