import { useEffect, useMemo, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { plural, split } from '#core/model';
import type { SearchFile, SearchHit } from '#ipc/git';
import { matches } from '#kernel/keymap';
import { refs, useApp, type DeepReadonly } from '#kernel/store';
import { Count } from '#ui/Count';
import { FileIcon } from '#ui/FileIcon';
import { Reveal } from '#ui/Reveal';
import { treeKey } from '#ui/treeKeys';
import { VirtualList } from '#ui/VirtualList';
import { openHit, runSearch, searchKey, setInclude, setQuery, toggleSearchFile } from './search';

const ROW_HEIGHT = 26;

type Line =
  | { kind: 'file'; file: DeepReadonly<SearchFile> }
  | { kind: 'hit'; path: string; hit: DeepReadonly<SearchHit> };

function flatten(files: readonly DeepReadonly<SearchFile>[], collapsed: ReadonlySet<string>): Line[] {
  const out: Line[] = [];
  for (const file of files) {
    out.push({ kind: 'file', file });
    if (!collapsed.has(file.path)) for (const hit of file.hits) out.push({ kind: 'hit', path: file.path, hit });
  }
  return out;
}

const onField = (e: KeyboardEvent<HTMLInputElement>): void => {
  if (matches(e, 'search.run')) {
    e.preventDefault();
    void runSearch();
  }
};

export function SearchPane() {
  const s = useApp();
  // the Set changes in place, so its contents are the memo's key
  const folded = [...s.searchCollapsed].join('\n');
  const lines = useMemo(() => flatten(s.searchFiles, s.searchCollapsed), [s.searchFiles, folded]);
  // the row the arrows are on: the hit last opened, until they move onto a file's own row
  const [cursor, setCursor] = useState<string | null>(null);
  useEffect(() => { setCursor(null); }, [s.searchSelected]);
  const cur = cursor ?? (s.searchSelected === null ? null : `h:${s.searchSelected}`);
  const at = cur === null ? -1 : lines.findIndex((l) => rowKey(l) === cur);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    const handled = treeKey(e.key, {
      count: lines.length,
      at,
      open: (i) => { const l = lines[i]!; return l.kind === 'file' ? !s.searchCollapsed.has(l.file.path) : null; },
      parent: (i) => {
        const l = lines[i]!;
        return l.kind === 'hit' ? lines.findIndex((f) => f.kind === 'file' && f.file.path === l.path) : -1;
      },
      go: (i) => {
        const l = lines[i]!;
        setCursor(rowKey(l));
        if (l.kind === 'hit') void openHit(l.path, l.hit);
      },
      toggle: (i) => { const l = lines[i]!; if (l.kind === 'file') toggleSearchFile(l.file.path); },
    });
    if (handled) e.preventDefault();
  };

  const total = s.searchFiles.reduce((n, f) => n + f.hits.length, 0);
  return (
    <div className="search">
      <div className="search-fields">
        <input type="text" className="search-field" placeholder="Search" aria-label="Search" value={s.searchQuery}
          autoComplete="off" spellCheck={false} ref={(el) => { refs.search = el; }}
          onChange={(e) => setQuery(e.target.value)} onKeyDown={onField} />
        <input type="text" className="search-field" placeholder="Folders or globs, e.g. src/ui, *.ts"
          aria-label="Folders to search" value={s.searchInclude} autoComplete="off" spellCheck={false}
          onChange={(e) => setInclude(e.target.value)} onKeyDown={onField} />
      </div>
      <div className="search-note" role="status">
        {s.searchError ?? (total
          ? <><Count value={total} format={(n) => plural(n, 'result')} /> in {plural(s.searchFiles.length, 'file')}</>
          : s.searchBusy ? 'Searching…' : s.searchQuery ? 'No results' : null)}
      </div>
      <Reveal when={s.searchTruncated} className="search-note">
        Only the first 20,000 are listed. Narrow the search to see the rest.
      </Reveal>
      <VirtualList label="Results" count={lines.length} rowHeight={ROW_HEIGHT} onKeyDown={onKeyDown}
        ref={(el) => { refs.list = el; }}
        reveal={cur === null ? null : { row: at, id: cur }}
        row={(i, id) => <Row key={rowKey(lines[i]!)} id={id} line={lines[i]!} selected={s.searchSelected} cur={i === at}
          collapsed={s.searchCollapsed} point={setCursor} />} />
    </div>
  );
}

const rowKey = (l: Line): string => (l.kind === 'file' ? `f:${l.file.path}` : `h:${searchKey(l.path, l.hit)}`);

function Row({ id, line, selected, cur, collapsed, point }: {
  id: string; line: Line; selected: string | null; cur: boolean; collapsed: ReadonlySet<string>;
  point(key: string): void;
}) {
  if (line.kind === 'file') {
    const { path, hits } = line.file;
    const [dir, name] = split(path);
    return (
      <div className={`sec d sfile${cur ? ' cur' : ''}`} id={id} role="treeitem" aria-level={1}
        aria-expanded={!collapsed.has(path)}
        data-path={path} title={path} style={{ '--depth': 0 } as CSSProperties}
        onClick={() => { point(rowKey(line)); toggleSearchFile(path); }}>
        <span className="l">
          <FileIcon name={name} />
          <span className="name">{name}</span>
          <span className="dir">{dir.slice(0, -1)}</span>
        </span>
        <span className="n">{hits.length}</span>
      </div>
    );
  }
  const key = searchKey(line.path, line.hit);
  return (
    <div className={`row f hit${key === selected ? ' sel' : ''}${cur ? ' cur' : ''}`} data-key={key}
      id={id} role="treeitem" aria-level={2} aria-selected={key === selected} title={`${line.path}:${line.hit.line}`}
      style={{ '--depth': 1 } as CSSProperties} onClick={() => void openHit(line.path, line.hit)}>
      <Preview hit={line.hit} />
    </div>
  );
}

function Preview({ hit }: { hit: DeepReadonly<SearchHit> }) {
  const parts: ReactNode[] = [];
  let at = 0;
  hit.ranges.forEach(([from = 0, to = 0], i) => {
    if (from > at) parts.push(hit.text.slice(at, from));
    parts.push(<mark key={i}>{hit.text.slice(from, to)}</mark>);
    at = to;
  });
  parts.push(hit.text.slice(at));
  return <span className="text">{hit.cut && '…'}{parts}</span>;
}
