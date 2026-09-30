import type { ReactNode } from 'react';
import { useId } from 'react';
import { Tabs as RT } from 'radix-ui';
import { motion, useIsPresent } from 'motion/react';
import { DUR, EASE, heavyMotion } from './motion';

/** `caption` draws the tab as a rail item: the icon on a tile, the caption under it. */
export type TabItem = { value: string; label: string; icon?: ReactNode; caption?: string };

/** The current item's fill: a `layoutId` sibling that Motion slides from the previous current item's last rect
 *  to this one's, `useId()`-scoped so two `Tabs` (or the Settings nav) never share an indicator. Negative
 *  `z-index` keeps it under the label regardless of source order. Under `lite` and `off` it has no `layoutId`,
 *  so it jumps instead of sliding. A `span`, not a `div`: it renders inside a tab's `button`, which admits only
 *  phrasing content. `layoutDependency` is the active value, so typing elsewhere does not re-measure it.
 *  `leaveOnExit` is for the terminal rail's tile, which can be mid-exit while it still holds the current tile's
 *  indicator, and two mounted indicators can never share one `layoutId`. Anywhere else the nearest `Presence`
 *  is a closing dialog's, and the indicator must stay for the dialog's own fade. */
export function TabIndicator({ id, value, className = 'tab-ind', leaveOnExit = false }: {
  id: string;
  value: unknown;
  className?: string;
  leaveOnExit?: boolean;
}) {
  const present = useIsPresent();
  if (leaveOnExit && !present) return null;
  return (
    <motion.span aria-hidden="true" className={className} transition={{ duration: DUR[3], ease: EASE.std }}
      {...(heavyMotion() ? { layoutId: id, layoutDependency: value } : {})} />
  );
}

export function Tabs({ value, onValueChange, items, vertical = false, indicatorId }: {
  value: string;
  onValueChange(v: string): void;
  items: TabItem[];
  vertical?: boolean;
  /** Shares the indicator with another `TabIndicator` outside this `Tabs` (the terminal rail's current tile),
   *  so it slides between the two instead of each keeping its own. Defaults to one scoped to this `Tabs`. */
  indicatorId?: string;
}) {
  const ownId = useId();
  const id = indicatorId ?? ownId;
  return (
    <RT.Root value={value} onValueChange={onValueChange} orientation={vertical ? 'vertical' : 'horizontal'}>
      <RT.List className={vertical ? 'tabs vert' : 'tabs'}>
        {items.map((t) => (
          <RT.Trigger key={t.value} className={t.caption ? 'tab rail-item' : 'tab'} value={t.value}
            aria-controls={undefined} title={t.icon ? t.label : undefined} aria-label={t.icon ? t.label : undefined}>
            {t.caption
              ? <><span className="tile">
                    {t.value === value && <TabIndicator id={id} value={value} className="rail-ind" />}
                    {t.icon}</span><span className="cap">{t.caption}</span></>
              : <>{t.value === value && <TabIndicator id={id} value={value} />}{t.icon ?? t.label}</>}
          </RT.Trigger>
        ))}
      </RT.List>
    </RT.Root>
  );
}
