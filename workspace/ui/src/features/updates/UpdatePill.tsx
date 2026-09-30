import { DropdownMenu } from 'radix-ui';
import { useApp } from '#kernel/store';
import { openReleaseNotes, restartToUpdate } from './updates';

export function UpdatePill() {
  const { update } = useApp();
  if (update === null) return null;
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button type="button" className="pill update-pill" title={`CodeBär ${update.version} is out`}>
          Update to {update.version} <span aria-hidden="true">▾</span>
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="menu" align="end" sideOffset={4}>
          <DropdownMenu.Item className="menu-item" onSelect={() => void restartToUpdate()}>
            Restart to Update
          </DropdownMenu.Item>
          {update.page !== null && (
            <DropdownMenu.Item className="menu-item" onSelect={openReleaseNotes}>What's New</DropdownMenu.Item>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
