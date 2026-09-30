import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { buildTree, split, STATUS_LABEL, treeStatus, type TreeDir } from '#core/model';
import { openPlain } from '#core/session';
import { copyItem } from '#kernel/clipboard';
import { refs, useApp } from '#kernel/store';
import { ContextMenu } from '#ui/ContextMenu';
import { FileIcon } from '#ui/FileIcon';
import { List } from '#ui/List';
import { DUR, STAGGER } from '#ui/motion';
import { consumeEntering, isJustOpened, toggleDir } from './files';

/** Rows beyond this in a freshly opened folder share its stagger delay, so a huge folder does not
 *  make the last row wait a second. */
const STAGGER_CAP = 19;

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
  // the row only exists once reveal() has opened its ancestors, so this waits on the same render
  useEffect(() => {
    const rows = refs.list?.querySelectorAll<HTMLElement>('.row.f') ?? [];
    [...rows].find((r) => r.dataset.path === active)?.scrollIntoView({ block: 'nearest' });
  }, [active, tree]);
  return (
    <List ref={(el) => { refs.list = el; }}>
      <TreeLevel node={tree} depth={0} active={active} ignored={set} st={st} />
    </List>
  );
}

type TreeStatus = ReturnType<typeof treeStatus>;

const ROLL_UP: Record<string, string> = {
  '!': 'Contains a conflict', A: 'Contains only new files', D: 'Contains deletions', M: 'Contains changes',
};

function RollUp({ letter }: { letter: string }) {
  const text = ROLL_UP[letter] ?? 'Contains changes';
  return <span className="st-dot" data-st={letter} title={text}>{text}</span>;
}

function TreeLevel(
  { node, depth, active, ignored, st, justOpened }:
  {
    node: TreeDir; depth: number; active: string | null; ignored: ReadonlySet<string>; st: TreeStatus;
    /** The path `toggleDir` just opened to reveal this level, so its rows animate in; undefined for
     *  the tree's first render, a tab switch, or a level whose own parent was already open. */
    justOpened?: string | undefined;
  },
) {
  const s = useApp();
  // set once at mount, so a later re-render does not add the entrance to a level that never had it; cleared
  // by the timeout below once the staggered animation has had time to finish, so a file the agent adds to this
  // folder afterwards does not also play it
  const [entering, setEntering] = useState(() => justOpened !== undefined);
  useEffect(() => { if (justOpened !== undefined) consumeEntering(justOpened); }, [justOpened]);
  useEffect(() => {
    if (!entering) return;
    const t = setTimeout(() => setEntering(false), (STAGGER_CAP * STAGGER + DUR[2]) * 1000 + 50);
    return () => clearTimeout(t);
  }, [entering]);
  const indent = { '--depth': depth } as CSSProperties;
  return (
    <>
      {node.dirs.map((d, i) => {
        const open = s.filesOpen.has(d.path);
        // git collapsed this one to a single entry, so opening it is what reads its contents;
        // asking the map rather than the node keeps a genuinely empty directory to one read
        const unlisted = ignored.has(`${d.path}/`) && !s.ignoredKids.has(d.path);
        const rolled = st.dirs.get(d.path);
        const style = entering ? { ...indent, '--i': Math.min(i, STAGGER_CAP) } as CSSProperties : indent;
        return (
          // a closed directory renders no children at all: the tree holds every file in the repo,
          // and this is what keeps a render proportional to what is on screen
          <details key={d.path} data-dir={d.path} open={open}
            onToggle={(e) => toggleDir(d.path, e.currentTarget.open, unlisted)}>
            <summary className={`sec d${entering ? ' entering' : ''}${ignored.has(`${d.path}/`) ? ' ignored' : ''}`}
              style={style} title={d.path}>
              <span className="l"><span className="name">{d.name}</span></span>
              {rolled && <RollUp letter={rolled} />}
            </summary>
            {open && (
              <TreeLevel node={d} depth={depth + 1} active={active} ignored={ignored} st={st}
                justOpened={isJustOpened(d.path) ? d.path : undefined} />
            )}
          </details>
        );
      })}
      {node.files.map((p, i) => {
        const letter = st.files.get(p);
        const style = entering
          ? { ...indent, '--i': Math.min(node.dirs.length + i, STAGGER_CAP) } as CSSProperties
          : indent;
        const cls = `row f${entering ? ' entering' : ''}${p === active ? ' sel' : ''}`
          + `${ignored.has(p) ? ' ignored' : ''}`;
        return (
          <ContextMenu key={p} items={[copyItem(p)]}>
            <div className={cls}
              data-key={`plain:${p}`} data-path={p} data-st={letter} style={style}
              role="button" aria-current={p === active || undefined} title={p} onClick={() => void openPlain(p)}>
              <FileIcon name={split(p)[1]} />
              <span className="path"><span className="name">{split(p)[1]}</span></span>
              {letter && <span className="st" title={STATUS_LABEL[letter] ?? letter}>{letter}</span>}
            </div>
          </ContextMenu>
        );
      })}
    </>
  );
}
