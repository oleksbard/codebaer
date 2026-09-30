import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { DUR, heavyMotion, SPRING } from './motion';

export type ToastItem = { id: number; message: string; kind: string };

/** The toast stack. Props only, since `ui/` cannot import `kernel/`. Enter from the right with the spring;
 *  exit with a fade and a height collapse, and `layout` on the rest so the stack closes up. Under `lite`:
 *  fade only, no slide, no height, no layout (the heavy-motion list names list reflow explicitly). The same under
 *  reduced motion, where `MotionConfig` stops the slide and the layout but would still run the height collapse. */
export function Toasts({ toasts, onDismiss, onHold }: {
  toasts: readonly ToastItem[];
  onDismiss(id: number): void;
  onHold(id: number, held: boolean): void;
}) {
  const still = useReducedMotion();
  const heavy = heavyMotion() && !still;
  // only a toast appearing or going away changes this, never a keystroke or a hover elsewhere
  const toastKey = toasts.map((t) => t.id).join(',');
  return (
    <div className="toasts">
      <AnimatePresence>
        {toasts.map((t) => (
          <motion.div key={t.id} layout={heavy} layoutDependency={toastKey} className={`toast ${t.kind}`}
            onClick={() => onDismiss(t.id)}
            onPointerEnter={() => onHold(t.id, true)} onPointerLeave={() => onHold(t.id, false)}
            initial={heavy ? { opacity: 0, x: 24 } : { opacity: 0 }}
            animate={{ opacity: 1, x: 0, transition: heavy ? SPRING : { duration: DUR[2] } }}
            exit={heavy
              ? { opacity: 0, height: 0, marginTop: 0, paddingTop: 0, paddingBottom: 0, borderTopWidth: 0,
                  borderBottomWidth: 0, transition: { duration: DUR[3] } }
              : { opacity: 0, transition: { duration: DUR[2] } }}>
            {t.message}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
