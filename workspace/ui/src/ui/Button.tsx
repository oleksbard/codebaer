import type { ButtonHTMLAttributes } from 'react';

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement>
  & { variant?: 'default' | 'primary' | 'ghost'; busy?: boolean };

export function Button({ variant = 'default', busy = false, className, ...props }: ButtonProps) {
  const cls = ['btn', variant === 'default' ? '' : variant, busy ? 'busy' : '', className ?? '']
    .filter(Boolean).join(' ');
  return <button type="button" className={cls} {...props} />;
}
