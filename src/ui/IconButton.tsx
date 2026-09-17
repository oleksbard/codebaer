import type { ButtonHTMLAttributes } from 'react';

export type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { label: string; busy?: boolean };

export function IconButton({ label, busy = false, className, ...props }: IconButtonProps) {
  const cls = ['ico', busy ? 'busy' : '', className ?? ''].filter(Boolean).join(' ');
  return <button type="button" className={cls} aria-label={label} title={label} {...props} />;
}
