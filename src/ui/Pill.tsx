import type { ReactNode } from 'react';

type PillProps = { tone?: 'default' | 'warn'; className?: string; children: ReactNode };

export function Pill({ tone = 'default', className, children }: PillProps) {
  const cls = ['pill', tone === 'default' ? '' : tone, className ?? ''].filter(Boolean).join(' ');
  return <span className={cls}>{children}</span>;
}
