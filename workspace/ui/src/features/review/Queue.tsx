import type { MouseEvent, ReactNode } from 'react';
import { rowKey, split, STATUS_LABEL, type Row, type Section } from '#core/model';
import { openPlain, openRow } from '#core/session';
import { copyItem } from '#kernel/clipboard';
import { keyLabel } from '#kernel/keymap';
import { refs } from '#kernel/store';
import { Badge } from '#ui/Badge';
import { ContextMenu, type MenuItem } from '#ui/ContextMenu';
import { FileIcon } from '#ui/FileIcon';
import { StrokeIcon } from '#ui/Icon';
import { IconButton } from '#ui/IconButton';
import { List } from '#ui/List';
import { acceptFile, rejectFile, stageAll, unstageAll, unstageFile } from './hunks';

const PLUS = 'M8 3v10M3 8h10';
const MINUS = 'M3 8h10';
const DISCARD = 'M5.5 3 2.5 6l3 3M2.5 6h7a4 4 0 0 1 0 8H7';

const stop = (fn: () => unknown) => (e: MouseEvent) => { e.stopPropagation(); void fn(); };

export function QueueList({ q, selected, open, onToggle }: {
  q: { unstaged: Row[]; staged: Row[] };
  selected: string | null;
  open: Record<Section, boolean>;
  onToggle(sec: Section, open: boolean): void;
}) {
  return (
    <List ref={(el) => { refs.list = el; }}>
      <SectionBlock id="unstaged" label="Changes" rows={q.unstaged} empty="Nothing left to review"
        selected={selected} open={open.unstaged} onToggle={onToggle}
        all={<IconButton label="Stage all changes" title={`Stage all changes (${keyLabel('review.stageAll')})`}
          data-all="stage"
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
          <IconButton label={`Stage file (${keyLabel('review.stageFile')})`} data-act="stage"
            onClick={stop(() => acceptFile(r.path))}>
            <StrokeIcon d={PLUS} size={14} /></IconButton>
          <IconButton label={`Discard changes (${keyLabel('review.discardFile')})`} data-act="revert"
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
          <span className="st" title={STATUS_LABEL[r.letter] ?? r.letter}>{r.letter}</span>
        </span>
      </div>
    </ContextMenu>
  );
}
