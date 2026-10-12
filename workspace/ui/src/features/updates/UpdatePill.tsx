import { DropdownMenu } from 'radix-ui';
import type { Update } from '#ipc/git';
import { useApp } from '#kernel/store';
import { inertOnClose, keepFocus } from '#ui/focus';
import { Reveal } from '#ui/Reveal';
import { Spinner } from '#ui/Spinner';
import { Tip } from '#ui/Tip';
import { openReleaseNotes, restartToUpdate } from './updates';

export function UpdatePill() {
  const { update, installing } = useApp();
  return (
    <Reveal when={update !== null} className="update-slot">
      {update && (update.blocked !== null ? <Blocked update={update} why={update.blocked} /> : (
        <DropdownMenu.Root>
          <Tip label={installing ? '' : `CodeBär ${update.version} is out`} align="end">
            <DropdownMenu.Trigger asChild>
              <button type="button" className="pill update-pill" disabled={installing}>
                {installing
                  ? <><Spinner />Downloading…</>
                  : <>Update to {update.version} <span aria-hidden="true">▾</span></>}
              </button>
            </DropdownMenu.Trigger>
          </Tip>
          <DropdownMenu.Portal>
            <DropdownMenu.Content className="menu" align="end" sideOffset={4} ref={inertOnClose}
              onCloseAutoFocus={keepFocus}>
              <DropdownMenu.Item className="menu-item" onSelect={() => void restartToUpdate()}>
                Restart to Update
              </DropdownMenu.Item>
              {update.page !== null && (
                <DropdownMenu.Item className="menu-item" onSelect={openReleaseNotes}>What's New</DropdownMenu.Item>
              )}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      ))}
    </Reveal>
  );
}

/** `aria-disabled` rather than `disabled`, which would take the focus and the pointer events the tip opens on. */
function Blocked({ update, why }: { update: Update; why: string }) {
  return (
    <Tip label={`CodeBär ${update.version} is out, but this copy cannot install it. ${why}`} align="end">
      <button type="button" className="pill update-pill" aria-disabled="true">Update to {update.version}</button>
    </Tip>
  );
}
