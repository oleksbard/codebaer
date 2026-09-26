import { useEffect, useMemo, type CSSProperties } from 'react';
import { buildTree, split, type TreeDir } from '#core/model';
import { openPlain } from '#core/session';
import { copyItem } from '#kernel/clipboard';
import { refs, useApp } from '#kernel/store';
import { ContextMenu } from '#ui/ContextMenu';
import { FileIcon } from '#ui/FileIcon';
import { List } from '#ui/List';
import { toggleDir } from './files';

/** `active` is the open file's path rather than S.selected, so a file opened from the Changes
 *  view is marked here too. */
export function FilesList({ files, ignored, active }: {
  files: readonly string[];
  ignored: readonly string[];
  active: string | null;
}) {
  const set = useMemo(() => new Set(ignored), [ignored]);
  const tree = useMemo(() => buildTree([...files, ...ignored]), [files, ignored]);
  // the row only exists once reveal() has opened its ancestors, so this waits on the same render
  useEffect(() => {
    const rows = refs.list?.querySelectorAll<HTMLElement>('.row.f') ?? [];
    [...rows].find((r) => r.dataset.path === active)?.scrollIntoView({ block: 'nearest' });
  }, [active, tree]);
  return (
    <List ref={(el) => { refs.list = el; }}>
      <TreeLevel node={tree} depth={0} active={active} ignored={set} />
    </List>
  );
}

function TreeLevel(
  { node, depth, active, ignored }:
  { node: TreeDir; depth: number; active: string | null; ignored: ReadonlySet<string> },
) {
  const s = useApp();
  const indent = { '--depth': depth } as CSSProperties;
  return (
    <>
      {node.dirs.map((d) => {
        const open = s.filesOpen.has(d.path);
        // git collapsed this one to a single entry, so opening it is what reads its contents;
        // asking the map rather than the node keeps a genuinely empty directory to one read
        const unlisted = ignored.has(`${d.path}/`) && !s.ignoredKids.has(d.path);
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
