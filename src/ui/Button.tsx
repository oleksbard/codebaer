import type { ButtonHTMLAttributes } from 'react';

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'default' | 'primary' | 'ghost' };

export function Button({ variant = 'default', className, ...props }: ButtonProps) {
  const cls = ['btn', variant === 'default' ? '' : variant, className ?? ''].filter(Boolean).join(' ');
  return <button type="button" className={cls} {...props} />;
}
