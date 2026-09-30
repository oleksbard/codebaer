import { useRef, type ComponentPropsWithoutRef, type KeyboardEvent, type ReactNode, type Ref } from 'react';
import { motion, useIsPresent } from 'motion/react';
import { DUR, EASE } from './motion';

export { LayoutGroup } from 'motion/react';

/** Motion redefines these with its own signature (or a stricter one, for `style`), so a generic
 *  `HTMLAttributes` passthrough onto a `motion.*` element cannot carry them; nothing here ever sets one. */
type NoMotionOverlap = 'onAnimationStart' | 'onDrag' | 'onDragStart' | 'onDragEnd' | 'style';

export function List({ children, ref }: { children: ReactNode; ref: Ref<HTMLDivElement> }) {
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    const list = e.currentTarget;
    // an exiting row (still in the DOM, mid fade) is also inert, and so is one whose whole section is fading
    // out (Reveal goes inert as a unit, not each row inside it); skipping both here is belt and braces on top
    // of ListRow dropping its own .sel, since a `.click()` call, unlike a real pointer event, ignores inert
    const all = [...list.querySelectorAll<HTMLElement>('.row')]
      .filter((r) => !r.closest('details:not([open])') && !r.closest('[inert]'));
    const sel = all.find((r) => r.classList.contains('sel')) ?? null;
    const i = sel ? all.indexOf(sel) : -1;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      all[Math.max(0, Math.min(all.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]?.click();
      e.preventDefault();
    } else if (e.key === 'Enter' && sel) {
      sel.click();
    }
  };
  // layoutScroll: this is the element that scrolls, so a descendant's layout animation (the queue's rows)
  // reads its own position relative to this scroll offset instead of mistaking a scroll for a layout change
  return (
    <motion.div className="list" tabIndex={0} ref={ref} onKeyDown={onKeyDown} layoutScroll>
      {children}
    </motion.div>
  );
}

/** A queue row (or a commit row), sharing `layout` and `exit` with its siblings inside a `Presence`. Off
 *  (a plain, unanimated element) above the row cap, when its section is closed, or under `lite`/`off`:
 *  the plan's whole "queue rows moving between sections" and "list reflow" effect is heavy motion, with no
 *  lite fallback fade, unlike a toast. `layoutId` is the file's path when the path is in only one section, and
 *  the row's own key when the file is partly staged (both rows mounted at once cannot share one `layoutId`).
 *  Named `ListRow`, not `Row`, since the queue's own `Row` type (a file's queue entry) already owns that name. */
export function ListRow({ ref, layoutId, layoutDependency, move, className, children, ...rest }: {
  ref?: Ref<HTMLDivElement>;
  layoutId?: string;
  layoutDependency?: unknown;
  move: boolean;
  className: string;
  children: ReactNode;
} & Omit<ComponentPropsWithoutRef<'div'>, 'className' | 'children' | 'ref' | NoMotionOverlap>) {
  // called even when !move: this row's Presence ancestor exists either way, so the hook stays unconditional
  const present = useIsPresent();
  // a row drawn plain first (its section closed, or the queue over the cap) is not new once it turns animated:
  // the element swap remounts it, and it must not fade in again
  const wasPlain = useRef(false);
  if (!move) {
    wasPlain.current = true;
    return <div ref={ref} className={className} {...rest}>{children}</div>;
  }
  // exiting: drops .sel so a stale selection never reads as current, and goes inert so List's own key
  // handling (which reads .sel from the DOM, not from React props) skips it too
  const cls = present ? className : className.replace(/(?:^|\s)sel(?=\s|$)/, '');
  return (
    <motion.div ref={ref} className={cls} layout="position" layoutDependency={layoutDependency} inert={!present}
      initial={wasPlain.current ? false : { opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      transition={{ layout: { duration: DUR[3], ease: EASE.std }, default: { duration: DUR[2], ease: EASE.std } }}
      {...(layoutId ? { layoutId } : {})} {...rest}>
      {children}
    </motion.div>
  );
}

/** The `<details>` a section of rows lives in: `layout="position"` so it slides to its new spot when a
 *  sibling section above it grows or shrinks, instead of jumping there the instant React re-renders. Named
 *  `ListSection`, not `Section`, since the queue's own `Section` type (unstaged/staged) already owns that name. */
export function ListSection({ move, layoutDependency, ...rest }: {
  move: boolean;
  layoutDependency?: unknown;
} & Omit<ComponentPropsWithoutRef<'details'>, NoMotionOverlap>) {
  if (!move) return <details {...rest} />;
  return (
    <motion.details layout="position" layoutDependency={layoutDependency}
      transition={{ duration: DUR[3], ease: EASE.std }} {...rest} />
  );
}
