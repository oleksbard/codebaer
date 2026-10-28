import { useEffect, useState } from 'react';
import { Button } from './Button';
import { CHECK, COPY, StrokeIcon } from './Icon';

const COPIED_MS = 1500;

/** Shows Copied for a moment when `copy` answers true; the caller reports a failure. `done` is what a screen
 *  reader hears. */
export function CopyButton({ copy, done, className }: {
  copy(): Promise<boolean>;
  done: string;
  className?: string | undefined;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <>
      <Button className={className} onClick={() => void copy().then(setCopied)}>
        <StrokeIcon d={copied ? CHECK : COPY} size={13} />{copied ? 'Copied' : 'Copy'}
      </Button>
      <span className="sr-only" role="status">{copied ? done : ''}</span>
    </>
  );
}
