import type { KeyboardEvent, ReactNode, Ref } from 'react';

export function List({ children, ref }: { children: ReactNode; ref: Ref<HTMLDivElement> }) {
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    const list = e.currentTarget;
    const all = [...list.querySelectorAll<HTMLElement>('.row')].filter((r) => !r.closest('details:not([open])'));
    const sel = all.find((r) => r.classList.contains('sel')) ?? null;
    const i = sel ? all.indexOf(sel) : -1;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      all[Math.max(0, Math.min(all.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]?.click();
      e.preventDefault();
    } else if (e.key === 'Enter' && sel) {
      sel.click();
    }
  };
  return <div className="list" tabIndex={0} ref={ref} onKeyDown={onKeyDown}>{children}</div>;
}
