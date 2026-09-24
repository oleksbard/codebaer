import {
  useEffect, useMemo, useRef, useState,
  type CSSProperties, type KeyboardEvent, type MouseEvent, type ReactNode,
} from 'react';
import { DropdownMenu } from 'radix-ui';
import { git, type Recent } from '../git';
import { buildQueue, buildTree, rowKey, split, type Row, type Section, type TreeDir } from '../model';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { ContextMenu, type MenuItem } from '../ui/ContextMenu';
import { FileIcon } from '../ui/FileIcon';
import { REFRESH, StrokeIcon } from '../ui/Icon';
import { IconButton } from '../ui/IconButton';
import { Kbd } from '../ui/Kbd';
import { Spinner } from '../ui/Spinner';
import { Tabs } from '../ui/Tabs';
import {
  acceptFile, aiMessage, cancel, checkout, commit, copyPath, findOrphans, network, openPlain, openRepo, openRow,
  openSettings,
  pickRepo, rejectFile,
  setTab, stageAll, toggleDir, unstageAll, unstageFile,
} from './controller';
import { notify, refs, S, useApp, type Tab } from './store';
import { TerminalRail } from './Terminals';

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

const PULL = 'M8 2v8M4.75 6.75 8 10l3.25-3.25M2.75 13.5h10.5';
const PUSH = 'M8 10V3M4.75 6.25 8 3l3.25 3.25M2.75 13.5h10.5';
const PLUS = 'M8 3v10M3 8h10';
const MINUS = 'M3 8h10';
const DISCARD = 'M5.5 3 2.5 6l3 3M2.5 6h7a4 4 0 0 1 0 8H7';

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
            Settings…<span className="detail">⌘,</span>
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
  useApp();
  const unstaged = S.status ? buildQueue(S.status).unstaged.length : 0;
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
      <Tabs vertical value={S.tab} onValueChange={(v) => void setTab(v as Tab)} items={tabs} />
      <TerminalRail />
    </div>
  );
}

function RepoLabel({ name, path }: { name: string; path: string }) {
  return (
    <span className="repo-label">
      <span className="name">{name}</span>
      <span className="dash">-</span>
      <span className="path">{path}</span>
    </span>
  );
}

function RepoSwitcher() {
  const [recent, setRecent] = useState<Recent[]>([]);
  if (!S.root) return null;
  return (
    <div className="side-head">
      <DropdownMenu.Root onOpenChange={(open) => { if (open) void git.recentRepos().then(setRecent); }}>
        <DropdownMenu.Trigger asChild>
          <button type="button" className="repo-trigger" title={`${S.rootLabel ?? S.root} - switch project`}>
            <span className="name">{S.title ?? split(S.root)[1]}</span>
            <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6"
              strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M4 6l4 4 4-4" />
            </svg>
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content className="menu repo-menu" align="start" sideOffset={4}>
            <DropdownMenu.Item className="menu-item" onSelect={() => void pickRepo()}>
              Open Folder…<span className="detail">⌘O</span>
            </DropdownMenu.Item>
            {recent.length > 0 && <DropdownMenu.Separator className="menu-sep" />}
            {recent.map((r) => (
              <DropdownMenu.Item key={r.path} className="menu-item" onSelect={() => void openRepo(r.path)}>
                <RepoLabel name={r.name} path={r.label} />
              </DropdownMenu.Item>
            ))}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  );
}

const stop = (fn: () => unknown) => (e: MouseEvent) => { e.stopPropagation(); void fn(); };

// the status is a bare colour dot now, so the letter it replaced becomes its tooltip
const ST_LABEL: Record<string, string> = {
  A: 'Added', C: 'Copied', D: 'Deleted', M: 'Modified', R: 'Renamed', T: 'Type changed',
  U: 'Untracked', '!': 'Conflict',
};

export function Sidebar() {
  useApp();
  const [open, setOpen] = useState<Record<Section, boolean>>({ unstaged: true, staged: true });
  const q = S.status ? buildQueue(S.status) : { unstaged: [], staged: [] };
  return (
    <aside className="side">
      <RepoSwitcher />
      {S.tab === 'files'
        ? <FilesList files={S.files} ignored={S.ignored} active={S.open?.path ?? null} />
        : <QueueList q={q} selected={S.selected} open={open}
          onToggle={(sec, v) => setOpen((o) => ({ ...o, [sec]: v }))} />}
      <CommitBox staged={q.staged.length} hidden={S.tab !== 'changes'} />
    </aside>
  );
}

function List({ children }: { children: ReactNode }) {
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    const list = e.currentTarget;
    const all = [...list.querySelectorAll<HTMLElement>('.row')].filter((r) => !r.closest('details:not([open])'));
    const sel = all.find((r) => r.classList.contains('sel')) ?? null;
    const i = sel ? all.indexOf(sel) : -1;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      all[Math.max(0, Math.min(all.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]?.click();
      e.preventDefault();
    } else if (e.key === 'Enter' && sel) {
      sel.click();
    }
  };
  return <div className="list" tabIndex={0} ref={(el) => { refs.list = el; }} onKeyDown={onKeyDown}>{children}</div>;
}

function QueueList({ q, selected, open, onToggle }: {
  q: { unstaged: Row[]; staged: Row[] };
  selected: string | null;
  open: Record<Section, boolean>;
  onToggle(sec: Section, open: boolean): void;
}) {
  return (
    <List>
      <SectionBlock id="unstaged" label="Changes" rows={q.unstaged} empty="Nothing left to review"
        selected={selected} open={open.unstaged} onToggle={onToggle}
        all={<IconButton label="Stage all changes" title="Stage all changes (⌘⌥Y)" data-all="stage"
          disabled={!q.unstaged.length}
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); void stageAll(); }}>
          <StrokeIcon d={PLUS} size={14} /></IconButton>} />
      <SectionBlock id="staged" label="Staged" rows={q.staged} empty="Accepted hunks land here"
        selected={selected} open={open.staged} onToggle={onToggle}
        all={<IconButton label="Unstage all changes" data-all="unstage" disabled={!q.staged.length}
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); void unstageAll(); }}>
          <StrokeIcon d={MINUS} size={14} /></IconButton>} />
    </List>
  );
}

function SectionBlock({ id, label, rows, empty, all, selected, open, onToggle }: {
  id: Section;
  label: string;
  rows: Row[];
  empty: string;
  all: ReactNode;
  selected: string | null;
  open: boolean;
  onToggle(sec: Section, open: boolean): void;
}) {
  return (
    <details data-sec={id} open={open} onToggle={(e) => onToggle(id, e.currentTarget.open)}>
      <summary className="sec">
        <span className="l">{label}</span>
        <span className="r">{all}<span className="n">{rows.length}</span></span>
      </summary>
      {rows.length
        ? rows.map((r) => <QueueRow key={rowKey(r)} row={r} selected={selected === rowKey(r)} />)
        : <div className="empty-sec">{empty}</div>}
    </details>
  );
}

const copyItem = (path: string): MenuItem => ({ label: 'Copy relative path', onSelect: () => void copyPath(path) });

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
          <IconButton label="Stage file (⌘⇧Y)" data-act="stage" onClick={stop(() => acceptFile(r.path))}>
            <StrokeIcon d={PLUS} size={14} /></IconButton>
          <IconButton label="Discard changes (⌘⇧N)" data-act="revert"
            onClick={stop(() => rejectFile(r.path))}><StrokeIcon d={DISCARD} size={14} /></IconButton>
        </>;
  return (
    <ContextMenu items={menuFor(r)}>
      <div className={`row${selected ? ' sel' : ''}`} data-key={rowKey(r)} data-st={r.letter} role="button"
        title={r.path} onClick={() => void openRow(r)}>
        <FileIcon name={name} />
        <span className="path"><span className="name">{name}</span>
          <span className="dir">{dirSlash.slice(0, -1)}</span></span>
        <span className="tail">
          {r.conflicted && <Badge>conflict</Badge>}
          <span className="acts">{acts}</span>
          <span className="st" title={ST_LABEL[r.letter] ?? r.letter}>{r.letter}</span>
        </span>
      </div>
    </ContextMenu>
  );
}

/** `active` is the open file's path rather than S.selected, so a file opened from the Changes
 *  view is marked here too. */
function FilesList({ files, ignored, active }: { files: string[]; ignored: string[]; active: string | null }) {
  const set = useMemo(() => new Set(ignored), [ignored]);
  const tree = useMemo(() => buildTree([...files, ...ignored]), [files, ignored]);
  // the row only exists once reveal() has opened its ancestors, so this waits on the same render
  useEffect(() => {
    const rows = refs.list?.querySelectorAll<HTMLElement>('.row.f') ?? [];
    [...rows].find((r) => r.dataset.path === active)?.scrollIntoView({ block: 'nearest' });
  }, [active, tree]);
  return <List><TreeLevel node={tree} depth={0} active={active} ignored={set} /></List>;
}

function TreeLevel(
  { node, depth, active, ignored }:
  { node: TreeDir; depth: number; active: string | null; ignored: ReadonlySet<string> },
) {
  const indent = { '--depth': depth } as CSSProperties;
  return (
    <>
      {node.dirs.map((d) => {
        const open = S.filesOpen.has(d.path);
        // git collapsed this one to a single entry, so opening it is what reads its contents;
        // asking the map rather than the node keeps a genuinely empty directory to one read
        const unlisted = ignored.has(`${d.path}/`) && !S.ignoredKids.has(d.path);
        return (
          // a closed directory renders no children at all: the tree holds every file in the repo,
          // and this is what keeps a render proportional to what is on screen
          <details key={d.path} data-dir={d.path} open={open}
            onToggle={(e) => toggleDir(d.path, e.currentTarget.open, unlisted)}>
            <summary className={`sec d${ignored.has(`${d.path}/`) ? ' ignored' : ''}`} style={indent} title={d.path}>
              <span className="l">{d.name}</span>
            </summary>
            {open && <TreeLevel node={d} depth={depth + 1} active={active} ignored={ignored} />}
          </details>
        );
      })}
      {node.files.map((p) => (
        <ContextMenu key={p} items={[copyItem(p)]}>
          <div className={`row f${p === active ? ' sel' : ''}${ignored.has(p) ? ' ignored' : ''}`}
            data-key={`plain:${p}`} data-path={p} style={indent}
            role="button" aria-current={p === active || undefined} title={p} onClick={() => void openPlain(p)}>
            <FileIcon name={split(p)[1]} />
            <span className="path"><span className="name">{split(p)[1]}</span></span>
          </div>
        </ContextMenu>
      ))}
    </>
  );
}

function Sparkle() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
      <path d="M6.5 1Q7.1 5.4 11.5 6.5Q7.1 7.6 6.5 12Q5.9 7.6 1.5 6.5Q5.9 5.4 6.5 1z" />
      <path d="M12.5 9.5Q12.8 11.7 15 12.2Q12.8 12.7 12.5 15Q12.2 12.7 10 12.2Q12.2 11.7 12.5 9.5z" />
    </svg>
  );
}

const commits = (n: number) => `${n} commit${n === 1 ? '' : 's'}`;

function RemoteActions() {
  const st = S.status;
  if (!st) return null;
  // git reports no ahead count without an upstream, and push is the thing that creates one,
  // so an untracked branch offers push rather than hiding it until it can be counted
  const push = st.upstream === null ? st.head !== null : st.ahead > 0 && st.behind === 0;
  return (
    <span className="remote">
      {st.upstream !== null &&
        <IconButton label="Fetch from remote" disabled={S.busy} onClick={() => void network('fetch')}>
          <StrokeIcon d={REFRESH} /></IconButton>}
      {st.behind > 0 &&
        <IconButton label={`Pull ${commits(st.behind)}`}
          disabled={S.busy} onClick={() => void network('pull')}><StrokeIcon d={PULL} /></IconButton>}
      {push &&
        <IconButton label={st.upstream === null ? 'Push and set upstream' : `Push ${commits(st.ahead)}`}
          disabled={S.busy} onClick={() => void network('push')}><StrokeIcon d={PUSH} /></IconButton>}
    </span>
  );
}

function BranchBar() {
  const st = S.status;
  const branch = !st ? '…' : st.head === null ? 'no commits' : st.branch ?? st.head.slice(0, 8);
  const ab = !st ? null : st.upstream
    ? <span className="ab">
        <span className={st.ahead ? 'on' : ''}>↑{st.ahead}</span>
        <span className={st.behind ? 'on' : ''}>↓{st.behind}</span>
      </span>
    : <span>no upstream</span>;
  return (
    <div className="branch">
      <button type="button" className="co" title="Checkout to…" onClick={() => void checkout()}>
        <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.4"
          aria-hidden="true">
          <circle cx="4.5" cy="3.5" r="1.5" />
          <circle cx="4.5" cy="12.5" r="1.5" />
          <circle cx="11.5" cy="5.5" r="1.5" />
          <path d="M4.5 5v6M11.5 7a3.5 3.5 0 0 1-3.5 3.5H4.5" />
        </svg>
        <span className="nm">{branch}</span>{ab}
      </button>
      {/* the remote actions are disabled while busy, so the spinner takes their place in the narrow row */}
      {S.busy
        ? <span className="busy"><Spinner />
            {S.cancellable && <Button variant="ghost" onClick={() => void cancel()}>Cancel</Button>}</span>
        : <RemoteActions />}
    </div>
  );
}

const AI_OFF = 'Turn on an AI provider in Settings to write commit messages';

function CommitBox({ staged, hidden }: { staged: number; hidden: boolean }) {
  useApp();
  const ref = useRef<HTMLTextAreaElement>(null);
  const message = S.commitMessage;
  const aiOn = S.settings['general.headless-ai-provider'] !== 'off';
  useEffect(() => {
    const el = ref.current;
    if (!el || hidden) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
  }, [message, hidden]);
  return (
    <div className="commit" hidden={hidden}>
      <BranchBar />
      <textarea id="commit-message" rows={1} placeholder="Commit message" aria-label="Commit message" value={message}
        ref={(el) => { ref.current = el; refs.commit = el; }}
        onChange={(e) => { S.commitMessage = e.target.value; notify(); }}
        onKeyDown={(e) => { if (e.key === 'Enter' && e.metaKey) { e.preventDefault(); void commit(); } }} />
      <div className="bar">
        <span className="hint">{staged ? `${staged} file${staged > 1 ? 's' : ''} staged` : 'Nothing staged yet'}</span>
        <span className="r">
          {/* a disabled .ico takes no pointer events, so the reason sits on a wrapper that does */}
          <span className="ai-wrap" title={aiOn ? undefined : AI_OFF}>
            <IconButton id="ai-btn" label={aiOn ? 'Write the commit message with Claude' : AI_OFF} busy={S.aiBusy}
              disabled={!aiOn || staged === 0 || S.aiBusy} onClick={() => void aiMessage()}><Sparkle /></IconButton>
          </span>
          <Button variant="primary" id="commit-btn" busy={S.committing}
            disabled={staged === 0 || !message.trim() || S.committing} onClick={() => void commit()}>
            {S.committing ? <><Spinner />Committing…</> : <>Commit <Kbd>⌘↩</Kbd></>}
          </Button>
        </span>
      </div>
    </div>
  );
}
