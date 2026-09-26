import { useState } from 'react';
import { DropdownMenu } from 'radix-ui';
import { buildQueue, type Section } from '#core/model';
import type { Tab } from '#core/state';
import { FilesList } from '#features/files';
import { CommitBox } from '#features/git-ops';
import { findOrphans } from '#features/orphans';
import { QueueList } from '#features/review';
import { openSettings } from '#features/settings';
import { TaskMenu } from '#features/tasks';
import { TerminalRail } from '#features/terminals';
import { keyLabel } from '#kernel/keymap';
import { useApp } from '#kernel/store';
import { Tabs } from '#ui/Tabs';
import { setTab } from './actions';

function ChangesIcon() {
  return (
    <svg viewBox="0 0 16 16" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.2"
      aria-hidden="true">
      <circle cx="4.5" cy="3" r="1.75" />
      <circle cx="4.5" cy="13" r="1.75" />
      <circle cx="11.5" cy="3" r="1.75" />
      <path d="M4.5 4.75v6.5M11.5 4.75v1.25a3 3 0 0 1-3 3h-4" />
    </svg>
  );
}

function FilesIcon() {
  return (
    <svg viewBox="0 0 16 16" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.2"
      strokeLinejoin="round" aria-hidden="true">
      <path d="M6.5 1.75h3L12.75 5v6.25a.75.75 0 0 1-.75.75H6.5a.75.75 0 0 1-.75-.75V2.5a.75.75 0 0 1 .75-.75z" />
      <path d="M9.5 1.75V5h3.25" />
      <path d="M10 14.25H4.75A.75.75 0 0 1 4 13.5V4.5" />
    </svg>
  );
}

function BrandMenu() {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button type="button" className="brand" aria-label="CodeBär menu">
          <img src="/icon.png" alt="" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="menu" side="right" align="start" sideOffset={6}>
          <DropdownMenu.Item className="menu-item" onSelect={() => void openSettings()}>
            Settings…<span className="detail">{keyLabel('settings.open')}</span>
          </DropdownMenu.Item>
          <DropdownMenu.Item className="menu-item" onSelect={() => void findOrphans()}>
            Terminals and Orphans…
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export function ActivityBar() {
  const s = useApp();
  const unstaged = s.status ? buildQueue(s.status).unstaged.length : 0;
  const tabs = [
    {
      value: 'changes',
      label: unstaged ? `Changes - ${unstaged} to review` : 'Changes',
      icon: (
        <span className="tab-icon">
          <ChangesIcon />
          {unstaged > 0 && <span className="tab-count" aria-hidden="true">{unstaged > 99 ? '99+' : unstaged}</span>}
        </span>
      ),
    },
    { value: 'files', label: 'Files', icon: <FilesIcon /> },
  ];
  return (
    <div className="act">
      <BrandMenu />
      <Tabs vertical value={s.tab} onValueChange={(v) => void setTab(v as Tab)} items={tabs} />
      <TaskMenu />
      <TerminalRail />
    </div>
  );
}

export function Sidebar() {
  const s = useApp();
  const [open, setOpen] = useState<Record<Section, boolean>>({ unstaged: true, staged: true });
  const q = s.status ? buildQueue(s.status) : { unstaged: [], staged: [] };
  return (
    <aside className="side">
      {s.tab === 'files'
        ? <FilesList files={s.files} ignored={s.ignored} active={s.open?.path ?? null} />
        : <QueueList q={q} selected={s.selected} open={open}
          onToggle={(sec, v) => setOpen((o) => ({ ...o, [sec]: v }))} />}
      <CommitBox staged={q.staged.length} hidden={s.tab !== 'changes'} />
    </aside>
  );
}
