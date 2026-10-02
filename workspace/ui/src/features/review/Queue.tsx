import type { MouseEvent, ReactNode, Ref } from 'react';
import { DropdownMenu } from 'radix-ui';
import { rowKey, split, STATUS_LABEL, type Row, type Section } from '#core/model';
import { openPlain } from '#core/session';
import { age, stash, undoCommit, unstash } from '#features/git-ops';
import type { Commit } from '#ipc/git';
import { copyItem } from '#kernel/clipboard';
import { keyLabel } from '#kernel/keymap';
import { refs, useApp } from '#kernel/store';
import { Badge } from '#ui/Badge';
import { ContextMenu, type MenuItem } from '#ui/ContextMenu';
import { FileIcon } from '#ui/FileIcon';
import { Count } from '#ui/Count';
import { inertOnClose, keepFocus } from '#ui/focus';
import { StrokeIcon } from '#ui/Icon';
import { IconButton } from '#ui/IconButton';
import { Kbd } from '#ui/Kbd';
import { LayoutGroup, List, ListRow, ListSection } from '#ui/List';
import { heavyMotion } from '#ui/motion';
import { Presence } from '#ui/Presence';
import { Reveal } from '#ui/Reveal';
import { Tip } from '#ui/Tip';
import { tipScope } from '#ui/tipScope';
import { pickRow, toggleAllChanges } from './all-changes';
import { acceptFile, discardAll, rejectFile, stageAll, unstageAll, unstageFile } from './hunks';

/** Above this many rows, a huge diff skips the queue's layout tracking: `layoutDependency` still limits
 *  measurement to renders where a row was added, removed or reordered, but not the measurement itself. */
const ROW_CAP = 150;

const PLUS = 'M8 3v10M3 8h10';
const STACK = 'M3.5 2.5h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1zM2.5 6.25h11M2.5 9.75h11';
const MINUS = 'M3 8h10';
const DISCARD = 'M5.5 3 2.5 6l3 3M2.5 6h7a4 4 0 0 1 0 8H7';
const MORE = 'M3.5 8h.01M8 8h.01M12.5 8h.01';
const BOX = 'M2.5 2.5h11v3h-11zM3.5 5.5v7a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1v-7';
const STASH = `${BOX}M8 7.5v4M6.25 9.75 8 11.5l1.75-1.75`;
const UNSTASH = `${BOX}M8 11.5v-4M6.25 9.25 8 7.5l1.75 1.75`;
const COMMIT = 'M1.5 8h4M10.5 8h4M8 5.5a2.5 2.5 0 1 1 0 5a2.5 2.5 0 1 1 0-5z';
const UNCOMMIT = 'M1.5 4.5h4M10.5 4.5h4M8 2a2.5 2.5 0 1 1 0 5a2.5 2.5 0 1 1 0-5zM8 7v7M5.75 11.75 8 14l2.25-2.25';

const stop = (fn: () => unknown) => (e: MouseEvent) => { e.stopPropagation(); void fn(); };

/** One entry of a section header. `id` is its `data-all`; an action that cannot run now is not shown. */
type HeaderAction = { id: string; label: string; icon: string; keys?: string; available: boolean; run(): unknown };

export type QueueSection = Section | 'commits';

export function QueueList({ q, selected, open, onToggle, allChanges }: {
  q: { unstaged: Row[]; staged: Row[] };
  selected: string | null;
  open: Record<QueueSection, boolean>;
  onToggle(sec: QueueSection, open: boolean): void;
  /** The All changes page is in the main pane. */
  allChanges: boolean;
}) {
  const s = useApp();
  const st = s.status;
  const { commits, more } = s.outgoing;
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
  const commitActions: HeaderAction[][] = [[
    { id: 'undo', label: 'Revert last commit', icon: UNCOMMIT, available: !s.committing, run: undoCommit },
  ]];

  const heavy = heavyMotion();
  const all = [...q.unstaged, ...q.staged];
  const canAnimate = heavy && all.length <= ROW_CAP;
  // the joined row keys: layoutDependency for every row and section, so typing or a hover change (which
  // notify() also fires) never makes Motion re-measure the queue, only an add, a remove or a reorder does
  const layoutKey = all.map(rowKey).join(',');
  // same idea, for the commits section: only an undo or a new commit changes this, never a keystroke
  const commitKey = commits.map((c) => c.oid).join(',');
  const pathCount = new Map<string, number>();
  for (const r of all) pathCount.set(r.path, (pathCount.get(r.path) ?? 0) + 1);
  // the path alone when it names one row; a partly staged file has one mounted in each section at once,
  // and two mounted rows can never share a layoutId
  const layoutIdFor = (r: Row) => ((pathCount.get(r.path) ?? 0) > 1 ? rowKey(r) : r.path);

  return (
    <LayoutGroup>
      <List ref={(el) => { refs.list = el; }}>
        <SectionBlock id="unstaged" label="Changes" count={q.unstaged.length} open={open.unstaged}
          onToggle={onToggle} actions={changes} pinned={[stageAllAction]}
          animate={canAnimate} layoutDependency={layoutKey}>
          <FileRows rows={q.unstaged} selected={selected} empty="Nothing left to review"
            animate={canAnimate && open.unstaged} layoutDependency={layoutKey} layoutIdFor={layoutIdFor} />
        </SectionBlock>
        <Reveal when={q.staged.length > 0} kind="fade">
          {q.staged.length > 0 &&
            <SectionBlock id="staged" label="Staged" count={q.staged.length} open={open.staged} onToggle={onToggle}
              actions={staged} animate={canAnimate} layoutDependency={layoutKey}>
              <FileRows rows={q.staged} selected={selected} animate={canAnimate && open.staged}
                layoutDependency={layoutKey} layoutIdFor={layoutIdFor} />
            </SectionBlock>}
        </Reveal>
        <Reveal when={commits.length > 0} kind="fade">
          {commits.length > 0 &&
            <SectionBlock id="commits" label="Commits" count={commits.length} more={more} open={open.commits}
              onToggle={onToggle} actions={commitActions}>
              <Presence mode={heavy ? 'popLayout' : 'sync'}>
                {commits.map((c) => (
                  <CommitRow key={c.oid} commit={c} animate={heavy} layoutDependency={commitKey} />
                ))}
              </Presence>
            </SectionBlock>}
        </Reveal>
      </List>
    </LayoutGroup>
  );
}

/** Inside a summary, a click would also fold the section. */
const keepOpen = (e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); };

function ActionButton({ a }: { a: HeaderAction }) {
  return (
    <IconButton label={a.label} kbd={a.keys ? keyLabel(a.keys) : undefined} data-all={a.id}
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
        <DropdownMenu.Content className="menu queue-menu" align="end" sideOffset={4} ref={inertOnClose}
          onCloseAutoFocus={keepFocus}>
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

function SectionBlock({
  id, label, count, more = false, actions, pinned = [], open, onToggle, children, animate = false, layoutDependency,
}: {
  id: QueueSection;
  label: string;
  count: number;
  /** There are more than `count`. */
  more?: boolean;
  actions: HeaderAction[][];
  /** Buttons of their own after the menu, shown while available. */
  pinned?: HeaderAction[];
  open: boolean;
  onToggle(sec: QueueSection, open: boolean): void;
  children: ReactNode;
  animate?: boolean;
  layoutDependency?: unknown;
}) {
  return (
    <ListSection data-sec={id} open={open} onToggle={(e) => onToggle(id, e.currentTarget.open)}
      move={animate} layoutDependency={layoutDependency}>
      <summary className="sec">
        <span className="l">{label}{count > 0 &&
          <span className="n"><Count value={count} format={(n) => `${n}${more ? '+' : ''}`} /></span>}</span>
        <span className="r">
          <HeaderActions section={label} groups={actions} />
          {pinned.filter((a) => a.available).map((a) => <ActionButton key={a.id} a={a} />)}
        </span>
      </summary>
      {children}
    </ListSection>
  );
}

function FileRows({ rows, selected, empty, animate, layoutDependency, layoutIdFor }: {
  rows: Row[];
  selected: string | null;
  empty?: string;
  animate: boolean;
  layoutDependency: unknown;
  layoutIdFor(r: Row): string;
}) {
  if (!rows.length) return <div className="empty-sec">{empty}</div>;
  return (
    <Presence mode={animate ? 'popLayout' : 'sync'}>
      {rows.map((r) => (
        <QueueRow key={rowKey(r)} row={r} selected={selected === rowKey(r)} animate={animate}
          layoutId={layoutIdFor(r)} layoutDependency={layoutDependency} />
      ))}
    </Presence>
  );
}

/** Not a `.row`: the list's arrow keys walk the files and pass these by. No `layoutId`: commits never share
 *  an identity with another mounted row, only their own position among the others. */
function CommitRow({ ref, commit: c, animate, layoutDependency }: {
  ref?: Ref<HTMLDivElement>; commit: Commit; animate: boolean; layoutDependency?: unknown;
}) {
  const short = c.oid.slice(0, 7);
  return (
    <Tip label={c.summary} detail={`${short} · ${c.author} · ${age(c.time)}`} slow align="start">
      <ListRow {...(ref ? { ref } : {})} className="commit-row" move={animate} layoutDependency={layoutDependency}
        data-oid={c.oid}>
        <StrokeIcon d={COMMIT} size={14} />
        <span className="summary">{c.summary}</span>
        <span className="oid">{short}</span>
      </ListRow>
    </Tip>
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

function QueueRow({ ref, row: r, selected, animate, layoutId, layoutDependency }: {
  ref?: Ref<HTMLElement>; row: Row; selected: boolean; animate: boolean; layoutId: string; layoutDependency: unknown;
}) {
  const [dirSlash, name] = split(r.path);
  const acts = r.section === 'staged'
    ? <IconButton label="Unstage file" data-act="unstage" onClick={stop(() => unstageFile(r.path))}>
      <StrokeIcon d={MINUS} size={14} /></IconButton>
    : r.conflicted
      ? <IconButton label="Mark resolved" data-act="stage" onClick={stop(() => acceptFile(r.path))}>
        <StrokeIcon d={PLUS} size={14} /></IconButton>
      : <>
          <IconButton label="Discard changes" kbd={keyLabel('review.discardFile')} data-act="revert"
            onClick={stop(() => rejectFile(r.path))}><StrokeIcon d={DISCARD} size={14} /></IconButton>
          <IconButton label="Stage file" kbd={keyLabel('review.stageFile')} data-act="stage"
            onClick={stop(() => acceptFile(r.path))}>
            <StrokeIcon d={PLUS} size={14} /></IconButton>
        </>;
  return (
    <ContextMenu items={menuFor(r)} {...(ref ? { ref } : {})}>
      <Tip label={r.path} slow mono align="start">
        <ListRow className={`row${selected ? ' sel' : ''}`} move={animate} layoutId={layoutId}
          layoutDependency={layoutDependency} data-key={rowKey(r)} data-st={r.letter} role="button"
          onClick={() => void pickRow(r)}>
          <FileIcon name={name} />
          <span className="path"><span className="name">{name}</span>
            <span className="dir">{dirSlash.slice(0, -1)}</span></span>
          <span className="tail">
            {r.conflicted && <Badge>conflict</Badge>}
            <span className="acts" onPointerMove={tipScope}>{acts}</span>
            <Tip label={STATUS_LABEL[r.letter] ?? r.letter}>
              <span className="st" onPointerMove={tipScope}>{r.letter}</span>
            </Tip>
          </span>
        </ListRow>
      </Tip>
    </ContextMenu>
  );
}
