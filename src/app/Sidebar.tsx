import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { buildQueue, rowKey, split, type Row, type Section } from '../model';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { ContextMenu, type MenuItem } from '../ui/ContextMenu';
import { FileIcon } from '../ui/FileIcon';
import { IconButton } from '../ui/IconButton';
import { Kbd } from '../ui/Kbd';
import { Spinner } from '../ui/Spinner';
import { Tabs } from '../ui/Tabs';
import { acceptFile, aiMessage, commit, openPlain, openRow, rejectFile, setTab, stageAll, unstageAll, unstageFile } from './controller';
import { notify, refs, S, useApp, type Tab } from './store';

function ChangesIcon() {
  return (
    <svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <circle cx="4.5" cy="3" r="1.75" />
      <circle cx="4.5" cy="13" r="1.75" />
      <circle cx="11.5" cy="3" r="1.75" />
      <path d="M4.5 4.75v6.5M11.5 4.75v1.25a3 3 0 0 1-3 3h-4" />
    </svg>
  );
}

function FilesIcon() {
  return (
    <svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true">
      <path d="M6.5 1.75h3L12.75 5v6.25a.75.75 0 0 1-.75.75H6.5a.75.75 0 0 1-.75-.75V2.5a.75.75 0 0 1 .75-.75z" />
      <path d="M9.5 1.75V5h3.25" />
      <path d="M10 14.25H4.75A.75.75 0 0 1 4 13.5V4.5" />
    </svg>
  );
}

const TABS = [
  { value: 'changes', label: 'Changes', icon: <ChangesIcon /> },
  { value: 'files', label: 'Files', icon: <FilesIcon /> },
];

export function ActivityBar() {
  useApp();
  return (
    <div className="act">
      <Tabs vertical value={S.tab} onValueChange={(v) => void setTab(v as Tab)} items={TABS} />
    </div>
  );
}

const stop = (fn: () => unknown) => (e: MouseEvent) => { e.stopPropagation(); void fn(); };

// the status is a bare colour dot now, so the letter it replaced becomes its tooltip
const ST_LABEL: Record<string, string> = {
  A: 'Added', C: 'Copied', D: 'Deleted', M: 'Modified', R: 'Renamed', T: 'Type changed', U: 'Untracked', '!': 'Conflict',
};

export function Sidebar() {
  useApp();
  const [open, setOpen] = useState<Record<Section, boolean>>({ unstaged: true, staged: true });
  const q = S.status ? buildQueue(S.status) : { unstaged: [], staged: [] };
  return (
    <aside className="side">
      {S.tab === 'files'
        ? <FilesList files={S.files} selected={S.selected} />
        : <QueueList q={q} selected={S.selected} open={open} onToggle={(sec, v) => setOpen((o) => ({ ...o, [sec]: v }))} />}
      <CommitBox staged={q.staged.length} hidden={S.tab !== 'changes'} />
    </aside>
  );
}

function List({ children }: { children: ReactNode }) {
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    const list = e.currentTarget;
    const sel = list.querySelector<HTMLElement>('details[open] .row.sel');
    const all = [...list.querySelectorAll<HTMLElement>('details[open] .row')];
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
      <SectionBlock id="unstaged" label="Changes" rows={q.unstaged} empty="Nothing left to review" selected={selected} open={open.unstaged} onToggle={onToggle}
        all={<IconButton label="Stage all changes" title="Stage all changes (⌘⌥Y)" data-all="stage" disabled={!q.unstaged.length}
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); void stageAll(); }}>+</IconButton>} />
      <SectionBlock id="staged" label="Staged" rows={q.staged} empty="Accepted hunks land here" selected={selected} open={open.staged} onToggle={onToggle}
        all={<IconButton label="Unstage all changes" data-all="unstage" disabled={!q.staged.length}
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); void unstageAll(); }}>−</IconButton>} />
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

function menuFor(r: Row): MenuItem[] {
  const openFile: MenuItem = { label: 'Open file', onSelect: () => void openPlain(r.path) };
  if (r.section === 'staged') return [{ label: 'Unstage file', onSelect: () => void unstageFile(r.path) }, openFile];
  if (r.conflicted) return [{ label: 'Mark resolved', onSelect: () => void acceptFile(r.path) }, openFile];
  return [
    { label: 'Stage file', onSelect: () => void acceptFile(r.path) },
    { label: 'Discard changes', onSelect: () => void rejectFile(r.path) },
    openFile,
  ];
}

function QueueRow({ row: r, selected }: { row: Row; selected: boolean }) {
  const [dirSlash, name] = split(r.path);
  const acts = r.section === 'staged'
    ? <IconButton label="Unstage file" data-act="unstage" onClick={stop(() => unstageFile(r.path))}>−</IconButton>
    : r.conflicted
      ? <IconButton label="Mark resolved" data-act="stage" onClick={stop(() => acceptFile(r.path))}>+</IconButton>
      : <>
          <IconButton label="Stage file (⌘⇧Y)" data-act="stage" onClick={stop(() => acceptFile(r.path))}>+</IconButton>
          <IconButton label="Discard changes (⌘⇧N)" data-act="revert" onClick={stop(() => rejectFile(r.path))}>↶</IconButton>
        </>;
  return (
    <ContextMenu items={menuFor(r)}>
      <div className={`row${selected ? ' sel' : ''}`} data-key={rowKey(r)} data-st={r.letter} role="button" title={r.path} onClick={() => void openRow(r)}>
        <FileIcon name={name} />
        <span className="path"><span className="name">{name}</span><span className="dir">{dirSlash.slice(0, -1)}</span></span>
        <span className="tail">
          {r.conflicted && <Badge>conflict</Badge>}
          <span className="acts">{acts}</span>
          <span className="st" title={ST_LABEL[r.letter] ?? r.letter}>{r.letter}</span>
        </span>
      </div>
    </ContextMenu>
  );
}

function FilesList({ files, selected }: { files: string[]; selected: string | null }) {
  const dirs = new Map<string, string[]>();
  for (const p of files) { const [d] = split(p); (dirs.get(d) ?? dirs.set(d, []).get(d)!).push(p); }
  return (
    <List>
      {[...dirs.keys()].sort().map((d) => (
        <details key={d} open>
          <summary className="sec d"><span className="l">{d || '/'}</span></summary>
          {dirs.get(d)!.map((p) => (
            <div key={p} className={`row f${selected === `plain:${p}` ? ' sel' : ''}`} data-key={`plain:${p}`} onClick={() => void openPlain(p)}>
              <FileIcon name={split(p)[1]} />
              <span className="path"><span className="name">{split(p)[1]}</span></span>
            </div>
          ))}
        </details>
      ))}
    </List>
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

function CommitBox({ staged, hidden }: { staged: number; hidden: boolean }) {
  useApp();
  const ref = useRef<HTMLTextAreaElement>(null);
  const message = S.commitMessage;
  useEffect(() => {
    const el = ref.current;
    if (!el || hidden) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
  }, [message, hidden]);
  return (
    <div className="commit" hidden={hidden}>
      <textarea id="commit-message" rows={1} placeholder="Commit message" aria-label="Commit message" value={message}
        ref={(el) => { ref.current = el; refs.commit = el; }}
        onChange={(e) => { S.commitMessage = e.target.value; notify(); }}
        onKeyDown={(e) => { if (e.key === 'Enter' && e.metaKey) { e.preventDefault(); void commit(); } }} />
      <div className="bar">
        <span className="hint">{staged ? `${staged} file${staged > 1 ? 's' : ''} staged` : 'Nothing staged yet'}</span>
        <span className="r">
          <IconButton id="ai-btn" label="Write the commit message with Claude" busy={S.aiBusy} disabled={staged === 0 || S.aiBusy} onClick={() => void aiMessage()}><Sparkle /></IconButton>
          <Button variant="primary" id="commit-btn" busy={S.committing} disabled={staged === 0 || S.committing} onClick={() => void commit()}>
            {S.committing ? <><Spinner />Committing…</> : <>Commit <Kbd>⌘↩</Kbd></>}
          </Button>
        </span>
      </div>
    </div>
  );
}
