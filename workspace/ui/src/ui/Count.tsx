import { useRef } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { DUR, heavyMotion } from './motion';

/** An exiting child does not re-render, so its own `exit` target would read whatever `custom` was true
 *  when it was still the current one (often stale, or 0 on its first render); `AnimatePresence`'s own
 *  `custom` reaches it instead, so the variant function below always reads the direction of the change
 *  that is removing it, not the one that mounted it. */
const variants = {
  initial: (dir: number) => ({ opacity: 0, y: dir * -4 }),
  animate: { opacity: 1, y: 0 },
  exit: (dir: number) => ({ opacity: 0, y: dir * 4 }),
};

/** A number that changes: the old value slides out and the new one slides in from the direction of the
 *  change, `mode="popLayout"` keyed by the shown text (not the raw value, so a change that does not move
 *  the text, such as the "99+" cap, does not animate). That is layout motion (the heavy-motion list in the
 *  plan names counters explicitly), so `lite` and `off` fall back to plain text. */
export function Count({ value, format = String }: { value: number; format?: (n: number) => string }) {
  const prev = useRef(value);
  // kept until the value changes again: a re-render with the same value during the exit would read 0 here
  const dir = useRef(0);
  if (value !== prev.current) {
    dir.current = Math.sign(value - prev.current);
    prev.current = value;
  }
  if (!heavyMotion()) return <span className="count">{format(value)}</span>;
  const text = format(value);
  return (
    <span className="count">
      <AnimatePresence mode="popLayout" initial={false} custom={dir.current}>
        <motion.span key={text} custom={dir.current} variants={variants} initial="initial" animate="animate"
          exit="exit" transition={{ duration: DUR[2] }}>
          {text}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}
