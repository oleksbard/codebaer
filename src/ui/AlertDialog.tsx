import { AlertDialog as RA } from 'radix-ui';
import { Button } from './Button';

export function AlertDialog({ title, body, confirmLabel = 'OK', onResult }: {
  title: string;
  body?: string;
  confirmLabel?: string;
  onResult(ok: boolean): void;
}) {
  return (
    <RA.Root open onOpenChange={(open) => { if (!open) onResult(false); }}>
      <RA.Portal>
        <RA.Overlay className="scrim" />
        <RA.Content className="dialog alert">
          <RA.Title className="dialog-title">{title}</RA.Title>
          {body ? <RA.Description className="dialog-body">{body}</RA.Description> : null}
          <div className="dialog-actions">
            <RA.Cancel asChild><Button>Cancel</Button></RA.Cancel>
            <RA.Action asChild><Button variant="primary" onClick={(e) => { e.preventDefault(); onResult(true); }}>{confirmLabel}</Button></RA.Action>
          </div>
        </RA.Content>
      </RA.Portal>
    </RA.Root>
  );
}
