import type { MouseEvent } from 'react';
import { DropdownMenu } from 'radix-ui';
import { rowKey, split, STATUS_LABEL, type Row, type Section } from '#core/model';
import { openPlain } from '#core/session';
import { stash, unstash } from '#features/git-ops';
import { copyItem } from '#kernel/clipboard';
import { keyLabel } from '#kernel/keymap';
import { refs, useApp } from '#kernel/store';
import { Badge } from '#ui/Badge';
import { ContextMenu, type MenuItem } from '#ui/ContextMenu';
import { FileIcon } from '#ui/FileIcon';
import { StrokeIcon } from '#ui/Icon';
import { IconButton } from '#ui/IconButton';
import { Kbd } from '#ui/Kbd';
import { List } from '#ui/List';
import { pickRow, toggleAllChanges } from './all-changes';
import { acceptFile, discardAll, rejectFile, stageAll, unstageAll, unstageFile } from './hunks';

const PLUS = 'M8 3v10M3 8h10';
const STACK = 'M3.5 2.5h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1zM2.5 6.25h11M2.5 9.75h11';
const MINUS = 'M3 8h10';
const DISCARD = 'M5.5 3 2.5 6l3 3M2.5 6h7a4 4 0 0 1 0 8H7';
const MORE = 'M3.5 8h.01M8 8h.01M12.5 8h.01';
const BOX = 'M2.5 2.5h11v3h-11zM3.5 5.5v7a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1v-7';
const STASH = `${BOX}M8 7.5v4M6.25 9.75 8 11.5l1.75-1.75`;
const UNSTASH = `${BOX}M8 11.5v-4M6.25 9.25 8 7.5l1.75 1.75`;

const stop = (fn: () => unknown) => (e: MouseEvent) => { e.stopPropagation(); void fn(); };

/** One entry of a section header. `id` is its `data-all`; an action that cannot run now is not shown. */
type HeaderAction = { id: string; label: string; icon: string; keys?: string; available: boolean; run(): unknown };

export function QueueList({ q, selected, open, onToggle, allChanges }: {
  q: { unstaged: Row[]; staged: Row[] };
  selected: string | null;
  open: Record<Section, boolean>;
  onToggle(sec: Section, open: boolean): void;
  /** The All changes page is in the main pane. */
  allChanges: boolean;
}) {
  const st = useApp().status;
  const hasHead = (st?.head ?? null) !== null;
  const conflicted = q.unstaged.some((r) => r.conflicted);
  const changes: HeaderAction[][] = [[
    {
      id: 'show', label: allChanges ? 'Close all changes' : 'Review all changes', icon: STACK,
      keys: 'review.allChanges', available: allChanges || q.unstaged.length > 0, run: toggleAllChanges,
    },
    { id: 'discard', label: 'Discard all changes', icon: DISCARD, available: q.unstaged.length > 0 && !conflicted,
      run: discardAll },
  ], [
    { id: 'stash', label: 'Stash changes', icon: STASH, available: hasHead && q.unstaged.length > 0 && !conflicted,
      run: () => stash('unstaged') },
    { id: 'unstash', label: 'Unstash…', icon: UNSTASH, available: hasHead && (st?.stash ?? 0) > 0 && !conflicted,
      run: unstash },
  ]];
  const stageAllAction: HeaderAction = {
    id: 'stage', label: 'Stage all changes', icon: PLUS, keys: 'review.stageAll', available: q.unstaged.length > 0,
    run: stageAll,
  };
  const staged: HeaderAction[][] = [[
    { id: 'unstage', label: 'Unstage all changes', icon: MINUS, available: q.staged.length > 0, run: unstageAll },
    { id: 'stash-staged', label: 'Stash staged changes', icon: STASH,
      available: hasHead && q.staged.length > 0 && !conflicted, run: () => stash('staged') },
  ]];
  return (
    <List ref={(el) => { refs.list = el; }}>
      <SectionBlock id="unstaged" label="Changes" rows={q.unstaged} empty="Nothing left to review"
        selected={selected} open={open.unstaged} onToggle={onToggle} actions={changes} pinned={[stageAllAction]} />
      <SectionBlock id="staged" label="Staged" rows={q.staged} empty="Accepted hunks land here"
        selected={selected} open={open.staged} onToggle={onToggle} actions={staged} />
    </List>
  );
}

/** Inside a summary, a click would also fold the section. */
const keepOpen = (e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); };

function ActionButton({ a }: { a: HeaderAction }) {
  return (
    <IconButton label={a.label} title={a.keys ? `${a.label} (${keyLabel(a.keys)})` : a.label} data-all={a.id}
      onClick={(e) => { keepOpen(e); void a.run(); }}>
      <StrokeIcon d={a.icon} size={14} /></IconButton>
  );
}

/** The one available action as its button, more than one in a menu with a separator between the groups. */
function HeaderActions({ section, groups }: { section: string; groups: HeaderAction[][] }) {
  const shown = groups.map((g) => g.filter((a) => a.available)).filter((g) => g.length);
  const all = shown.flat();
  if (!all.length) return null;
  const only = all.length === 1 ? all[0] : undefined;
  if (only) return <ActionButton a={only} />;
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <IconButton label={`${section} actions`} data-all="menu" onClick={keepOpen}>
          <StrokeIcon d={MORE} size={14} /></IconButton>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="menu queue-menu" align="end" sideOffset={4}>
          {shown.map((group, i) => [
            i > 0 && <DropdownMenu.Separator key={`sep${i}`} className="menu-sep" />,
            ...group.map((a) => (
              <DropdownMenu.Item key={a.id} className="menu-item" data-all={a.id} onSelect={() => void a.run()}>
                <StrokeIcon d={a.icon} size={14} />{a.label}
                {a.keys && <span className="detail"><Kbd>{keyLabel(a.keys)}</Kbd></span>}
              </DropdownMenu.Item>
            )),
          ])}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function SectionBlock({ id, label, rows, empty, actions, pinned = [], selected, open, onToggle }: {
  id: Section;
  label: string;
  rows: Row[];
  empty: string;
  actions: HeaderAction[][];
  /** Buttons of their own after the menu, shown while available. */
  pinned?: HeaderAction[];
  selected: string | null;
  open: boolean;
  onToggle(sec: Section, open: boolean): void;
}) {
  return (
    <details data-sec={id} open={open} onToggle={(e) => onToggle(id, e.currentTarget.open)}>
      <summary className="sec">
        <span className="l">{label}{rows.length > 0 && <span className="n">{rows.length}</span>}</span>
        <span className="r">
          <HeaderActions section={label} groups={actions} />
          {pinned.filter((a) => a.available).map((a) => <ActionButton key={a.id} a={a} />)}
        </span>
      </summary>
      {rows.length
        ? rows.map((r) => <QueueRow key={rowKey(r)} row={r} selected={selected === rowKey(r)} />)
        : <div className="empty-sec">{empty}</div>}
    </details>
  );
}

function menuFor(r: Row): MenuItem[] {
  const openFile: MenuItem = { label: 'Open file', onSelect: () => void openPlain(r.path) };
  if (r.section === 'staged') {
    return [{ label: 'Unstage file', onSelect: () => void unstageFile(r.path) }, openFile, copyItem(r.path)];
  }
  if (r.conflicted) {
    return [{ label: 'Mark resolved', onSelect: () => void acceptFile(r.path) }, openFile, copyItem(r.path)];
  }
  return [
    { label: 'Stage file', onSelect: () => void acceptFile(r.path) },
    { label: 'Discard changes', onSelect: () => void rejectFile(r.path) },
    openFile,
    copyItem(r.path),
  ];
}

function QueueRow({ row: r, selected }: { row: Row; selected: boolean }) {
  const [dirSlash, name] = split(r.path);
  const acts = r.section === 'staged'
    ? <IconButton label="Unstage file" data-act="unstage" onClick={stop(() => unstageFile(r.path))}>
      <StrokeIcon d={MINUS} size={14} /></IconButton>
    : r.conflicted
      ? <IconButton label="Mark resolved" data-act="stage" onClick={stop(() => acceptFile(r.path))}>
        <StrokeIcon d={PLUS} size={14} /></IconButton>
      : <>
          <IconButton label={`Discard changes (${keyLabel('review.discardFile')})`} data-act="revert"
            onClick={stop(() => rejectFile(r.path))}><StrokeIcon d={DISCARD} size={14} /></IconButton>
          <IconButton label={`Stage file (${keyLabel('review.stageFile')})`} data-act="stage"
            onClick={stop(() => acceptFile(r.path))}>
            <StrokeIcon d={PLUS} size={14} /></IconButton>
        </>;
  return (
    <ContextMenu items={menuFor(r)}>
      <div className={`row${selected ? ' sel' : ''}`} data-key={rowKey(r)} data-st={r.letter} role="button"
        title={r.path} onClick={() => void pickRow(r)}>
        <FileIcon name={name} />
        <span className="path"><span className="name">{name}</span>
          <span className="dir">{dirSlash.slice(0, -1)}</span></span>
        <span className="tail">
          {r.conflicted && <Badge>conflict</Badge>}
          <span className="acts">{acts}</span>
          <span className="st" title={STATUS_LABEL[r.letter] ?? r.letter}>{r.letter}</span>
        </span>
      </div>
    </ContextMenu>
  );
}
