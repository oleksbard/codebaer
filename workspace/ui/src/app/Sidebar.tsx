import { useId, useState } from 'react';
import { DropdownMenu } from 'radix-ui';
import { buildQueue } from '#core/model';
import type { Tab } from '#core/state';
import { openAiTools } from '#features/ai-tools';
import { FilesList } from '#features/files';
import { CommitBox } from '#features/git-ops';
import { SearchPane } from '#features/search';
import { findOrphans } from '#features/orphans';
import { allChangesShown, QueueList, type QueueSection } from '#features/review';
import { openSettings } from '#features/settings';
import { TaskMenu, TaskSubmenu } from '#features/tasks';
import { TerminalRail } from '#features/terminals';
import { checkForUpdates } from '#features/updates';
import { keyLabel } from '#kernel/keymap';
import { run } from '#kernel/registry';
import { useApp } from '#kernel/store';
import { Count } from '#ui/Count';
import { inertOnClose, keepFocus } from '#ui/focus';
import { glowLayer } from '#ui/glow';
import { REFRESH, StrokeIcon } from '#ui/Icon';
import { Kbd } from '#ui/Kbd';
import { LayoutGroup } from '#ui/List';
import { ChangesIcon, FilesIcon, GearIcon, SearchIcon, SparkleIcon, TerminalIcon } from '#ui/AppIcons';
import { Tabs } from '#ui/Tabs';
import { setTab } from './actions';

const TABS = [
  { value: 'changes', caption: 'Changes', icon: <ChangesIcon />, command: null },
  { value: 'files', caption: 'Files', icon: <FilesIcon />, command: 'files.show' },
  { value: 'search', caption: 'Search', icon: <SearchIcon />, command: 'search.show' },
] as const;

function BrandMenu() {
  const s = useApp();
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button type="button" className="brand" aria-label="CodeBär menu">
          <img src="/icon.png" alt="" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="menu app-menu" side="right" align="start" sideOffset={6}
          ref={inertOnClose} onCloseAutoFocus={keepFocus}>
          <DropdownMenu.Item className="menu-item" onSelect={() => void openSettings()}>
            <GearIcon />Settings…<span className="detail"><Kbd>{keyLabel('settings.open')}</Kbd></span>
          </DropdownMenu.Item>
          <DropdownMenu.Item className="menu-item" onSelect={openAiTools}>
            <SparkleIcon />Explore AI Tools…
          </DropdownMenu.Item>
          <DropdownMenu.Item className="menu-item" onSelect={() => void findOrphans()}>
            <TerminalIcon />Terminals and Orphans…
          </DropdownMenu.Item>
          {s.canUpdate && (
            <DropdownMenu.Item className="menu-item" onSelect={() => void checkForUpdates()}>
              <StrokeIcon d={REFRESH} />Check for Updates…
            </DropdownMenu.Item>
          )}
          <DropdownMenu.Separator className="menu-sep" />
          {TABS.map((t) => (
            <DropdownMenu.Item key={t.value} className="menu-item"
              onSelect={() => { if (t.command) run(t.command); else void setTab(t.value); }}>
              {t.icon}{t.caption}
              {t.command && keyLabel(t.command) && (
                <span className="detail"><Kbd>{keyLabel(t.command)}</Kbd></span>
              )}
            </DropdownMenu.Item>
          ))}
          <TaskSubmenu />
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export function ActivityBar() {
  const s = useApp();
  const unstaged = s.status ? buildQueue(s.status).unstaged.length : 0;
  const tabs = TABS.filter((t) => s.settings[`sidebar.${t.value}`] !== 'hide').map((t) => (t.value === 'changes'
    ? {
      value: t.value,
      label: unstaged ? `Changes - ${unstaged} to review` : 'Changes',
      caption: t.caption,
      icon: (
        <span className="tab-icon">
          {t.icon}
          {unstaged > 0 &&
            <span className="tab-count" aria-hidden="true">
              <Count value={unstaged} format={(n) => n > 99 ? '99+' : String(n)} />
            </span>}
        </span>
      ),
    }
    : { value: t.value, label: t.caption, caption: t.caption, icon: t.icon }));
  // one id, so the current-item fill slides between here and the terminal rail's own current tile
  const indicatorId = useId();
  return (
    <div className="act">
      <BrandMenu />
      <LayoutGroup>
        <Tabs vertical value={s.tab} onValueChange={(v) => void setTab(v as Tab)} items={tabs}
          indicatorId={indicatorId} />
        {s.settings['sidebar.commands'] !== 'hide' && <TaskMenu />}
        <TerminalRail indicatorId={indicatorId} />
      </LayoutGroup>
    </div>
  );
}

export function Sidebar() {
  const s = useApp();
  const [open, setOpen] = useState<Record<QueueSection, boolean>>({ unstaged: true, staged: true, commits: true });
  const q = s.status ? buildQueue(s.status) : { unstaged: [], staged: [] };
  return (
    <aside className="side glow" ref={glowLayer}>
      {s.folderOnly
        ? <div className="side-note">
          {s.gitMissing === null ? 'This folder has no git repository' : 'git is not installed'}
        </div>
        : s.tab === 'files'
          ? <FilesList files={s.files} ignored={s.ignored} active={s.open?.path ?? null} />
          : s.tab === 'search' ? <SearchPane />
            : <QueueList q={q} selected={s.selected} open={open} allChanges={allChangesShown(s)}
              onToggle={(sec, v) => setOpen((o) => ({ ...o, [sec]: v }))} />}
      <CommitBox staged={q.staged.length} hidden={s.tab !== 'changes' || s.folderOnly} />
    </aside>
  );
}
