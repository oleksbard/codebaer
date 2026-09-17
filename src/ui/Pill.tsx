import type { ReactNode } from 'react';

export function Pill({ tone = 'default', className, children }: { tone?: 'default' | 'warn'; className?: string; children: ReactNode }) {
  const cls = ['pill', tone === 'default' ? '' : tone, className ?? ''].filter(Boolean).join(' ');
  return <span className={cls}>{children}</span>;
}
