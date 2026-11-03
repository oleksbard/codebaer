import { useRef, type ComponentPropsWithoutRef, type ReactNode, type Ref } from 'react';
import { Reorder } from 'motion/react';
import { heavyMotion, SPRING } from './motion';

/** A column of `Pop` tiles that the pointer drags into a new order. Motion places the other tiles from `values`
 *  while a drag goes on, so `onReorder` gets the order at each swap and must render it at once. `display:
 *  contents`, so the scrolling parent, which Motion scrolls when the pointer comes near its edge, is the caller's
 *  own list. */
export function PopList<T>({ values, onReorder, children }: {
  values: T[];
  onReorder: (order: T[]) => void;
  children: ReactNode;
}) {
  return (
    <Reorder.Group as="div" axis="y" values={values} onReorder={onReorder} style={{ display: 'contents' }}>
      {children}
    </Reorder.Group>
  );
}

/** A tile of a `PopList` that pops in on mount (scale .85 to 1, the spring) and, at `full`, fades and scales down
 *  on the way out while its neighbours close up around it. The caller wraps its tiles in `Presence` so React defers
 *  the unmount for the exit. The pointer drags it to a new place in the list, and the click that ends a drag does
 *  nothing. The pop stays under `lite` (a light, one-shot transform); the exit does not, and the neighbours jump to
 *  their places, since list reflow is heavy motion. Motion still tracks the layout there, because a drag reads the
 *  order from it. Under `off`, `setMotion` sets `MotionGlobalConfig.skipAnimations`, which skips this too, like
 *  every other Motion animation, not only the heavy ones. */
export function Pop<T>({ ref, value, className, layoutDependency, onPointerDown, onClick, children, ...rest }: {
  ref?: Ref<HTMLButtonElement>;
  value: T;
  className: string;
  layoutDependency?: unknown;
  children: ReactNode;
  // Motion redefines these with its own signature (or a stricter one, for `style`); nothing here sets one
} & Omit<ComponentPropsWithoutRef<'button'>, 'className' | 'children' | 'ref' | 'value' | 'onAnimationStart'
  | 'onDrag' | 'onDragStart' | 'onDragEnd' | 'style'>) {
  const heavy = heavyMotion();
  const dragged = useRef(false);
  return (
    <Reorder.Item as="button" type="button" value={value} className={className} layoutDependency={layoutDependency}
      initial={{ opacity: 0, scale: .85 }} animate={{ opacity: 1, scale: 1 }}
      transition={heavy ? SPRING : { ...SPRING, layout: { duration: 0 } }}
      {...(heavy ? { exit: { opacity: 0, scale: .85 } } : {})}
      onPointerDown={(e) => { dragged.current = false; onPointerDown?.(e); }}
      onDragStart={() => { dragged.current = true; }}
      // a drag that ends off the tile leaves the mark set, and a key's click (detail 0) must still get through
      onClick={(e) => { if (!dragged.current || e.detail === 0) onClick?.(e); }}
      ref={ref ?? null} {...rest}>
      {children}
    </Reorder.Item>
  );
}
