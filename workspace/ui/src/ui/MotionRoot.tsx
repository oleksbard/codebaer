import type { ReactNode } from 'react';
import { MotionConfig } from 'motion/react';

/** Wraps the whole app once: under reduced motion, `reducedMotion="user"` keeps every motion component's
 *  opacity and drops its transform, so no keyframe or component needs its own reduced-motion case. */
export function MotionRoot({ children }: { children: ReactNode }) {
  return <MotionConfig reducedMotion="user">{children}</MotionConfig>;
}
