import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Tip, type TipProps } from './Tip';

export type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  busy?: boolean;
  /** The shortcut, from `keyLabel()`. */
  kbd?: string | undefined;
  /** Shown in place of `label` when the tip has more to say than the button's name. */
  tip?: ReactNode;
  side?: TipProps['side'];
};

export function IconButton({ label, busy = false, className, kbd, tip, side, ...props }: IconButtonProps) {
  const cls = ['ico', busy ? 'busy' : '', className ?? ''].filter(Boolean).join(' ');
  return (
    <Tip label={tip ?? label} kbd={kbd} side={side}>
      <button type="button" className={cls} aria-label={label} {...props} />
    </Tip>
  );
}
