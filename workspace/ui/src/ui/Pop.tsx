import type { ComponentPropsWithoutRef, ReactNode, Ref } from 'react';
import { motion } from 'motion/react';
import { heavyMotion, SPRING } from './motion';

/** A tile that pops in on mount (scale .85 to 1, the spring) and, at `full`, fades and scales down on the way
 *  out while its `layout`-tracked neighbours close up around it. The caller wraps its list in `Presence` so
 *  React defers the unmount for the exit. The pop stays under `lite` (a light, one-shot transform); the exit
 *  and the neighbours' reflow do not, since list reflow is heavy motion, so removal there is instant. Under
 *  `off`, `setMotion` sets `MotionGlobalConfig.skipAnimations`, which skips this too, like every other Motion
 *  animation, not only the heavy ones. */
export function Pop({ ref, className, layoutDependency, children, ...rest }: {
  ref?: Ref<HTMLButtonElement>;
  className: string;
  layoutDependency?: unknown;
  children: ReactNode;
  // Motion redefines these with its own signature (or a stricter one, for `style`); nothing here sets one
} & Omit<ComponentPropsWithoutRef<'button'>, 'className' | 'children' | 'ref' | 'onAnimationStart' | 'onDrag'
  | 'onDragStart' | 'onDragEnd' | 'style'>) {
  const heavy = heavyMotion();
  return (
    <motion.button ref={ref} type="button" className={className}
      initial={{ opacity: 0, scale: .85 }} animate={{ opacity: 1, scale: 1 }} transition={SPRING}
      {...(heavy ? { layout: true, layoutDependency, exit: { opacity: 0, scale: .85 } } : {})} {...rest}>
      {children}
    </motion.button>
  );
}
