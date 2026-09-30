import { MotionGlobalConfig } from 'motion/react';

export type MotionLevel = 'full' | 'lite' | 'off';

/** The level every `:root[data-motion]` rule and `heavyMotion()` read. */
export function setMotion(level: MotionLevel): void {
  document.documentElement.dataset.motion = level;
  MotionGlobalConfig.skipAnimations = level === 'off';
}

/** Browser mode and the test setup call `setMotion` before the app loads; this only picks the
 *  platform's default when nothing has. */
export function initMotion(platform: string): void {
  if (document.documentElement.dataset.motion) return;
  setMotion(platform === 'linux' ? 'lite' : 'full');
}

export function motionLevel(): MotionLevel {
  const level = document.documentElement.dataset.motion;
  return level === 'lite' || level === 'off' ? level : 'full';
}

/** Layout, height and infinite-loop motion: off under `lite` (slower WebKitGTK) and `off`. */
export const heavyMotion = (): boolean => motionLevel() === 'full';

/** Seconds, for Motion transitions; kept equal to tokens.css by ui/motion.test.ts. */
export const DUR = {
  1: 0.09,
  2: 0.14,
  3: 0.24,
  4: 0.4,
  5: 0.65,
  spin: 0.8,
  loop: 1.2,
} as const;

/** Cubic-bezier control points, in tokens.css order; kept equal to it by ui/motion.test.ts. */
export const EASE = {
  std: [0.2, 0, 0, 1],
  out: [0.2, 0.8, 0.2, 1],
  pop: [0.34, 1.56, 0.64, 1],
} as const;

/** Seconds, the stagger between rows of a staggered entrance; kept equal to tokens.css by ui/motion.test.ts. */
export const STAGGER = 0.045;

export const SPRING = { type: 'spring', stiffness: 420, damping: 32 } as const;
