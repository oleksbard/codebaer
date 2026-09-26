import { useState, type ReactNode } from 'react';
import { Tooltip } from 'radix-ui';

/** An (i) that shows `children` on hover, keyboard focus or a click. */
export function InfoTip({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <Tooltip.Provider delayDuration={150}>
      <Tooltip.Root open={open} onOpenChange={setOpen}>
        <Tooltip.Trigger asChild>
          {/* Radix closes a tooltip on a press at its trigger, and a press is how most people ask an (i) */}
          <button type="button" className="info-tip" aria-label={label}
            onPointerDown={(e) => e.preventDefault()}
            onClick={(e) => { e.preventDefault(); setOpen(true); }}>
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.3"
              strokeLinecap="round" aria-hidden="true">
              <circle cx="8" cy="8" r="6.25" />
              <path d="M8 7.25v3.75" />
              <circle cx="8" cy="5" r="0.4" fill="currentColor" />
            </svg>
          </button>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content className="tip" side="bottom" align="start" sideOffset={6} collisionPadding={8}>
            {children}
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}
