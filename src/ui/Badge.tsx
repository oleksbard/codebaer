import type { ReactNode } from 'react';

export function Badge({ className, children }: { className?: string; children: ReactNode }) {
  return <span className={['badge', className ?? ''].filter(Boolean).join(' ')}>{children}</span>;
}
