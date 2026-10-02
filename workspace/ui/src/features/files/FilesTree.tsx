import { useEffect, useMemo, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { buildTree, flattenTree, split, STATUS_LABEL, treeStatus, type TreeLine } from '#core/model';
import { openPlain } from '#core/session';
import { copyItem } from '#kernel/clipboard';
import { refs, useApp } from '#kernel/store';
import { ContextMenu } from '#ui/ContextMenu';
import { FileIcon } from '#ui/FileIcon';
import { treeKey } from '#ui/treeKeys';
import { VirtualList } from '#ui/VirtualList';
import { toggleDir } from './files';

const ROW_HEIGHT = 26;

/** `active` is the open file's path rather than S.selected, so a file opened from the Changes
 *  view is marked here too. */
export function FilesList({ files, ignored, active }: {
  files: readonly string[];
  ignored: readonly string[];
  active: string | null;
}) {
  const s = useApp();
  const set = useMemo(() => new Set(ignored), [ignored]);
  const tree = useMemo(() => buildTree([...files, ...ignored]), [files, ignored]);
  const listed = useMemo(() => new Set(files), [files]);
  const st = useMemo(() => treeStatus(s.status, listed), [s.status, listed]);
  // S.filesOpen changes in place, so this cannot be memoized on it; it visits only the open folders
  const lines = flattenTree(tree, s.filesOpen);
  // the row the arrows are on: the open file, until they move onto a folder
  const [cursor, setCursor] = useState<string | null>(null);
  useEffect(() => { setCursor(null); }, [active]);
  const cur = cursor ?? (active === null ? null : `f:${active}`);
  const at = cur === null ? -1 : lines.findIndex((l) => key(l) === cur);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    const handled = treeKey(e.key, {
      count: lines.length,
      at,
      open: (i) => { const l = lines[i]!; return l.kind === 'dir' ? s.filesOpen.has(l.dir.path) : null; },
      parent: (i) => lines.findIndex((l) => l.kind === 'dir' && l.dir.path === lines[i]!.parent),
      go: (i) => {
        const l = lines[i]!;
        setCursor(key(l));
        if (l.kind === 'file') void openPlain(l.path);
      },
      toggle: (i) => {
        const l = lines[i]!;
        if (l.kind !== 'dir') return;
        const { path } = l.dir;
        toggleDir(path, !s.filesOpen.has(path), set.has(`${path}/`) && !s.ignoredKids.has(path));
      },
    });
    if (handled) e.preventDefault();
  };

  return (
    <VirtualList label="Files" count={lines.length} rowHeight={ROW_HEIGHT} onKeyDown={onKeyDown}
      ref={(el) => { refs.list = el; }}
      reveal={cur === null ? null : { row: at, id: cur }}
      row={(i, id) => (
        <Line key={key(lines[i]!)} id={id} line={lines[i]!} active={active} cur={i === at} ignored={set} st={st}
          open={s.filesOpen} read={s.ignoredKids} point={setCursor} />
      )} />
  );
}

const key = (l: TreeLine): string => (l.kind === 'dir' ? `d:${l.dir.path}` : `f:${l.path}`);

type TreeStatus = ReturnType<typeof treeStatus>;

const ROLL_UP: Record<string, string> = {
  '!': 'Contains a conflict', A: 'Contains only new files', D: 'Contains deletions', M: 'Contains changes',
};

function RollUp({ letter }: { letter: string }) {
  const text = ROLL_UP[letter] ?? 'Contains changes';
  return <span className="st-dot" data-st={letter} title={text}>{text}</span>;
}

function Line({ id, line, active, cur, ignored, st, open, read, point }: {
  id: string; line: TreeLine; active: string | null; cur: boolean; ignored: ReadonlySet<string>; st: TreeStatus;
  open: ReadonlySet<string>; read: ReadonlyMap<string, readonly string[]>;
  /** Moves the arrows' cursor to a folder clicked; a file clicked opens, and the cursor follows the open file. */
  point(key: string): void;
}) {
  const style = { '--depth': line.depth } as CSSProperties;
  if (line.kind === 'dir') {
    const d = line.dir;
    const isOpen = open.has(d.path);
    const dimmed = ignored.has(`${d.path}/`);
    // git collapsed this one to a single entry, so opening it is what reads its contents;
    // asking the map rather than the node keeps a genuinely empty directory to one read
    const unlisted = dimmed && !read.has(d.path);
    const rolled = st.dirs.get(d.path);
    return (
      <div className={`sec d${dimmed ? ' ignored' : ''}${cur ? ' cur' : ''}`}
        data-dir={d.path} id={id} role="treeitem" aria-level={line.depth + 1} aria-expanded={isOpen} style={style}
        title={d.path}
        onClick={() => { point(key(line)); toggleDir(d.path, !isOpen, unlisted); }}>
        <span className="l"><span className="name">{d.name}</span></span>
        {rolled && <RollUp letter={rolled} />}
      </div>
    );
  }
  const p = line.path;
  const name = split(p)[1];
  const letter = st.files.get(p);
  const cls = `row f${p === active ? ' sel' : ''}${ignored.has(p) ? ' ignored' : ''}`
    + (cur ? ' cur' : '');
  return (
    <ContextMenu items={[copyItem(p)]}>
      <div className={cls} data-key={`plain:${p}`} data-path={p} data-st={letter} style={style}
        id={id} role="treeitem" aria-level={line.depth + 1} aria-selected={p === active} title={p}
        onClick={() => void openPlain(p)}>
        <FileIcon name={name} />
        <span className="path"><span className="name">{name}</span></span>
        {letter && <span className="st" title={STATUS_LABEL[letter] ?? letter}>{letter}</span>}
      </div>
    </ContextMenu>
  );
}
