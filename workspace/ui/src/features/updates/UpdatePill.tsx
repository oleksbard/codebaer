import { DropdownMenu } from 'radix-ui';
import { useApp } from '#kernel/store';
import { inertOnClose, keepFocus } from '#ui/focus';
import { Reveal } from '#ui/Reveal';
import { Spinner } from '#ui/Spinner';
import { openReleaseNotes, restartToUpdate } from './updates';

export function UpdatePill() {
  const { update, installing } = useApp();
  return (
    <Reveal when={update !== null} className="update-slot">
      {update && (
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button type="button" className="pill update-pill" disabled={installing}
              title={installing ? `Downloading CodeBär ${update.version}…` : `CodeBär ${update.version} is out`}>
              {installing
                ? <><Spinner />Downloading…</>
                : <>Update to {update.version} <span aria-hidden="true">▾</span></>}
            </button>
          </DropdownMenu.Trigger>
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
      )}
    </Reveal>
  );
}
