import {
  createContext, useContext, type FocusEvent, type HTMLAttributes, type ReactElement, type ReactNode, type Ref,
} from 'react';
import { Slot, Tooltip } from 'radix-ui';
import { Kbd } from './Kbd';

/** In ms. The first tip waits `open`; for `skip` after one closes, the next opens at once, so moving along a
 *  toolbar reads each button without a wait. A `slow` tip waits longer and never opens at once: a list's rows
 *  sit under the pointer on its way elsewhere. Tests set them all to 0. */
export const TIP_DELAY = { open: 500, skip: 300, slow: 800 };

const Shared = createContext(false);

/** One per app, so the skip delay carries from one tip to the next. A `Tip` outside it brings its own. */
export function TipProvider({ children }: { children: ReactNode }) {
  return (
    <Tooltip.Provider delayDuration={TIP_DELAY.open} skipDelayDuration={TIP_DELAY.skip}>
      <Shared.Provider value={true}>{children}</Shared.Provider>
    </Tooltip.Provider>
  );
}

type FocusHandler = (e: FocusEvent<HTMLElement>) => void;

function visibleFocus(e: FocusEvent<HTMLElement>): boolean {
  try { return e.currentTarget.matches(':focus-visible'); } catch { return true; /* an engine without it */ }
}

/** Takes the trigger props Radix gives, minus the tooltip's `data-state`: it would replace the one the child
 *  sets itself (a tab's `active`, a menu trigger's `open`), which styles and tests read. `state` is the one an
 *  outer `asChild` trigger, such as `ContextMenu`'s, handed the Tip. `ownFocus` is the Tip's own `onFocus`.
 *  The tooltip's `onFocus` runs only on a visible focus: Radix opens a tip on any focus, and focus also comes back
 *  to a trigger when its menu or dialog closes, and follows the pointer along a menu's items. It is skipped, not
 *  prevented, because Radix then skips the child's handlers too, and a menu item would never highlight. */
function KeepState({ state, ownFocus, children, ...props }: {
  state: string | undefined; ownFocus?: FocusHandler | undefined; children: ReactElement; 'data-state'?: string;
} & HTMLAttributes<HTMLElement> & { ref?: Ref<HTMLElement> }) {
  const tipFocus = props.onFocus;
  const onFocus = ownFocus || tipFocus
    ? (e: FocusEvent<HTMLElement>) => { ownFocus?.(e); if (tipFocus && visibleFocus(e)) tipFocus(e); }
    : undefined;
  // an undefined prop still replaces the child's own value, and Radix sends `aria-describedby` as one while closed
  const set = Object.fromEntries(Object.entries({ ...props, onFocus, 'data-state': state })
    .filter(([, v]) => v !== undefined));
  return <Slot.Root {...set}>{children}</Slot.Root>;
}

export type TipProps = {
  /** Nothing to say renders `children` alone. A string keeps its line breaks. */
  label: ReactNode;
  /** The shortcut, from `keyLabel()`, drawn as a key after the label. */
  kbd?: string | undefined;
  /** A muted line under the label. */
  detail?: ReactNode;
  side?: 'top' | 'right' | 'bottom' | 'left' | undefined;
  align?: 'start' | 'center' | 'end' | undefined;
  slow?: boolean | undefined;
  /** Paths and commands: monospaced, and broken anywhere rather than overflowing. */
  mono?: boolean | undefined;
  /** One element that takes a ref and pointer events: a disabled button gets neither, so wrap it in a span. */
  children: ReactElement;
  /** Forwarded to `children` with the rest of the props, so a Tip can itself be the child of an `asChild`
   *  trigger such as `ContextMenu`'s, and `Presence` can reach the element. */
  ref?: Ref<HTMLButtonElement>;
} & Omit<HTMLAttributes<HTMLElement>, 'children'>;

/** The app's tooltip. The trigger keeps its own `aria-label`: a tip is only described while it shows. */
export function Tip({
  label, kbd, detail, side = 'bottom', align = 'center', slow = false, mono = false, children, onFocus,
  'data-state': state, ...rest
}: TipProps & { 'data-state'?: string }) {
  const shared = useContext(Shared);
  if (label === null || label === undefined || label === false || label === '') {
    return <KeepState state={state} ownFocus={onFocus} {...rest}>{children}</KeepState>;
  }
  const tip = (
    <Tooltip.Root disableHoverableContent {...(slow ? { delayDuration: TIP_DELAY.slow } : {})}>
      <Tooltip.Trigger asChild {...rest}>
        <KeepState state={state} ownFocus={onFocus}>{children}</KeepState>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className={`tip tip-s${mono ? ' mono' : ''}`} side={side} align={align} sideOffset={6}
          collisionPadding={8}>
          <span className="tip-line">
            <span className="tip-label">{label}</span>
            {kbd && <Kbd>{kbd}</Kbd>}
          </span>
          {detail && <span className="tip-detail">{detail}</span>}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
  if (shared && !slow) return tip;
  return (
    <Tooltip.Provider delayDuration={slow ? TIP_DELAY.slow : TIP_DELAY.open}
      skipDelayDuration={slow ? 0 : TIP_DELAY.skip}>
      {tip}
    </Tooltip.Provider>
  );
}
