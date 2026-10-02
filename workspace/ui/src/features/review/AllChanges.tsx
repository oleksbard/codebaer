import { useEffect, useRef, type RefObject } from 'react';
import { buildQueue, plural, split, STATUS_LABEL, type Row } from '#core/model';
import { chunkCount, lineStat } from '#editor/editor';
import { PendingPill } from '#features/comments';
import { keyLabel } from '#kernel/keymap';
import { useApp } from '#kernel/store';
import { Button } from '#ui/Button';
import { DiffStat } from '#ui/DiffStat';
import { FileIcon } from '#ui/FileIcon';
import { StrokeIcon } from '#ui/Icon';
import { IconButton } from '#ui/IconButton';
import { Pill } from '#ui/Pill';
import { Tip } from '#ui/Tip';
import {
  bindScroller, bindSection, closeAllChanges, collapseAll, LARGE, nearScreen, openSection, scrolled, sectionOf,
  showLarge, spy, toggleSection,
} from './all-changes';
import { acceptFile, rejectFile } from './hunks';
import { ImageDiff } from './ImageDiff';
import { previews } from './images';
import { sideChosen } from './layout';
import { LayoutButton, PANEL_TEXT, useDiffStat } from './ReviewPane';

const FOLD_ALL = 'M5 2.5l3 3 3-3M5 13.5l3-3 3 3';
const UNFOLD_ALL = 'M5 5.5l3-3 3 3M5 10.5l3 3 3-3';

export function AllChanges() {
  const s = useApp();
  const box = useRef<HTMLDivElement>(null);
  useSections(box);
  useEffect(() => {
    bindScroller(box.current);
    spy();
    return () => bindScroller(null);
  }, []);
  const stat = useDiffStat(s.status);
  const page = s.allChanges;
  if (!page) return null;
  const q = s.status ? buildQueue(s.status) : { unstaged: [], staged: [] };
  const rows = new Map(q.unstaged.map((r) => [r.path, r]));
  const staged = new Set(q.staged.map((r) => r.path));
  const unfolded = page.order.some((p) => rows.has(p) && !page.collapsed.has(p));
  return (
    <main className="main">
      <div className="tbar">
        <span className="file">All changes</span>
        <span className="pos">{rows.size ? `${plural(rows.size, 'file')} to review` : 'nothing left to review'}</span>
        {stat && stat.added + stat.removed > 0 ? <DiffStat added={stat.added} removed={stat.removed} /> : null}
        <div className="right">
          <PendingPill />
          <LayoutButton />
          <IconButton label={unfolded ? 'Collapse all files' : 'Expand all files'}
            onClick={() => collapseAll(unfolded)}>
            <StrokeIcon d={unfolded ? FOLD_ALL : UNFOLD_ALL} size={14} /></IconButton>
          <IconButton label="Close all changes" kbd={keyLabel('review.allChanges')}
            onClick={() => void closeAllChanges()}>✕</IconButton>
        </div>
      </div>
      <div className="stack" ref={box} onScroll={scrolled}>
        {page.order.length
          ? page.order.map((p) => (
            <FileSection key={p} path={p} row={rows.get(p) ?? null} staged={staged.has(p)}
              collapsed={page.collapsed.has(p)} opened={page.shown.has(p)} side={sideChosen(s)} />
          ))
          : <div className="blank"><h2>Nothing left to review</h2></div>}
      </div>
    </main>
  );
}

/** Loads a file as it comes near the screen, and keeps what is on screen still while a file above it
 *  loads, folds away or re-reads. The page scrolls itself, so the browser's own scroll anchoring is off
 *  in the CSS, or the two would both move it. */
function useSections(box: RefObject<HTMLDivElement | null>): void {
  const near = useRef<IntersectionObserver>(null);
  const sized = useRef<ResizeObserver>(null);
  useEffect(() => {
    const root = box.current!;
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const p = (e.target as HTMLElement).dataset.path;
        if (p !== undefined) nearScreen(p, e.isIntersecting);
      }
    }, { root, rootMargin: '800px 0px' });
    const heights = new WeakMap<Element, number>();
    const ro = new ResizeObserver((entries) => {
      const edge = root.getBoundingClientRect().top;
      const changed = entries.map((e) => e.target as HTMLElement)
        .sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
      let shift = 0;
      for (const el of changed) {
        const h = el.offsetHeight;
        const was = heights.get(el);
        heights.set(el, h);
        if (was === undefined) continue;
        // its bottom before the change: past the top edge, it and everything after it were on screen. A file
        // scrolled to sits flush under the edge, so the one above it ends right on it, give or take a subpixel
        if (el.getBoundingClientRect().top - shift + was > edge + 1) break;
        shift += h - was;
      }
      if (shift) root.scrollTop += shift;
    });
    near.current = io;
    sized.current = ro;
    return () => { io.disconnect(); ro.disconnect(); };
  }, [box]);
  // every render, since files join the page as the agent writes them; observing a node twice is a no-op
  useEffect(() => {
    for (const el of box.current?.querySelectorAll('.fsec') ?? []) {
      near.current?.observe(el);
      sized.current?.observe(el);
    }
  });
}

function FileSection({ path, row, staged, collapsed, opened, side }: {
  path: string;
  /** Null once the file has left the queue: accepted, rejected, or reverted by the agent. */
  row: Row | null;
  staged: boolean;
  collapsed: boolean;
  opened: boolean;
  side: boolean;
}) {
  const { status } = useApp();
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    bindSection(path, ref.current);
    return () => bindSection(path, null);
  }, [path]);
  const sec = sectionOf(path);
  const v = sec?.view ?? null;
  const [dir, name] = split(path);
  const stat = v ? lineStat(v.state) : null;
  const changed = stat ? stat.added + stat.removed : 0;
  const large = changed > LARGE && !opened;
  const hunks = v ? chunkCount(v.state) : 0;
  const folded = collapsed || !row;
  const image = !folded && !!sec && previews(path, sec.panel);
  const note = folded || !sec || image ? null
    : sec.panel === 'Conflicted' ? 'conflict, open the file to resolve the markers'
      : sec.panel === 'Large' ? 'large file'
        : sec.panel ? `${PANEL_TEXT[sec.panel] ?? sec.error ?? sec.panel}, whole-file actions only`
          : !v ? null
            : !hunks ? 'line endings, filters, or file mode only'
              : large ? `${changed.toLocaleString()} changed lines` : null;
  const waiting = !folded && (!sec || (!v && !sec.panel));
  const gate = (sec?.panel === 'Large' || (large && hunks > 0)) && !folded;
  return (
    <section ref={ref} className={`fsec${row ? '' : ' done'}`} data-path={path} data-st={row?.letter}>
      <header className="fhead">
        <button type="button" className="fold" aria-expanded={!folded} disabled={!row}
          aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${path}`} onClick={() => toggleSection(path)} />
        <Tip label={path} slow mono align="start">
          <span className="file"><FileIcon name={name} />
            <span className="txt"><span className="dir">{dir}</span>{name}</span></span>
        </Tip>
        {row
          ? <Tip label={STATUS_LABEL[row.letter] ?? row.letter}><span className="st">{row.letter}</span></Tip>
          : <Pill>{staged ? 'accepted' : 'no changes left'}</Pill>}
        {row && stat && changed ? <DiffStat added={stat.added} removed={stat.removed} /> : null}
        {row && (
          <div className="right">
            <Button variant="ghost" onClick={() => void openSection(path)}>Open</Button>
            {!row.conflicted && <>
              <Button onClick={() => void rejectFile(path)}>Reject file</Button>
              <Button onClick={() => void acceptFile(path)}>Accept file</Button>
            </>}
          </div>
        )}
      </header>
      <div className={side ? 'fbody split' : 'fbody'} hidden={folded || !v || !hunks || large} />
      {waiting && <div className="fwait" />}
      {image && <ImageDiff path={path} view="unstaged" tick={status} />}
      {note && <div className="fnote">{note}
        {gate ? <Button onClick={() => showLarge(path)}>Show diff</Button> : null}</div>}
    </section>
  );
}
