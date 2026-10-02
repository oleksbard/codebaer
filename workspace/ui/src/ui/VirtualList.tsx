import {
  useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode, type Ref,
} from 'react';

/** Rows drawn past each edge of the viewport, so a fast scroll does not show a blank band first. */
const OVERSCAN = 10;
/** jsdom lays nothing out, so a list that has no height yet draws as if it were this tall. */
const FALLBACK_HEIGHT = 800;

/** A scrolling tree that draws only the rows in view, for trees as long as a repository. Every row is
 *  `rowHeight` px tall: `.vlist-body > *` holds it to that. The list keeps the focus and the arrows move a cursor
 *  (`reveal.row`), so a row is a `treeitem` with the `id` it is given, and the cursor is the active descendant.
 *  `reveal` scrolls its row into view once per `id`, and again only when the id changes, so a row that moves
 *  because a folder above it opened stays put; a row that is not there yet (-1) is revealed once it is. */
export function VirtualList({ label, count, rowHeight, row, ref, onKeyDown, reveal }: {
  label: string;
  count: number;
  rowHeight: number;
  row: (i: number, id: string) => ReactNode;
  ref?: Ref<HTMLDivElement>;
  onKeyDown?: (e: KeyboardEvent<HTMLDivElement>) => void;
  reveal?: { row: number; id: string } | null;
}) {
  const base = useId();
  const box = useRef<HTMLDivElement | null>(null);
  const body = useRef<HTMLDivElement | null>(null);
  const revealed = useRef<string | null>(null);
  // the first row in view and the viewport's height, rather than scrollTop: a scroll that stays inside one row
  // changes neither, so it renders nothing
  const [view, setView] = useState({ start: 0, height: 0 });
  const measure = (): void => {
    const el = box.current;
    if (!el) return;
    const start = Math.floor(el.scrollTop / rowHeight);
    const height = el.clientHeight;
    setView((v) => (v.start === start && v.height === height ? v : { start, height }));
  };
  useLayoutEffect(() => {
    measure();
    const observer = new ResizeObserver(measure);
    if (box.current) observer.observe(box.current);
    return () => observer.disconnect();
  }, [rowHeight]);
  useLayoutEffect(() => {
    if (!reveal) { revealed.current = null; return; }
    const el = box.current;
    if (!el || reveal.row < 0 || revealed.current === reveal.id) return;
    revealed.current = reveal.id;
    const top = (body.current?.offsetTop ?? 0) + reveal.row * rowHeight;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + rowHeight > el.scrollTop + el.clientHeight) el.scrollTop = top + rowHeight - el.clientHeight;
    measure();
  });
  const height = view.height || FALLBACK_HEIGHT;
  const inView = Math.ceil(height / rowHeight);
  // a list that shrank (a new search, a repo switch) is shorter than where it was scrolled: the browser clamps
  // scrollTop only once the body is short again, so the window has to start no later than the last rows
  const start = Math.min(view.start, Math.max(0, count - inView));
  const first = Math.max(0, start - OVERSCAN);
  const last = Math.min(count, start + inView + OVERSCAN);
  const rows: ReactNode[] = [];
  for (let i = first; i < last; i++) rows.push(row(i, `${base}${i}`));
  const at = reveal?.row ?? -1;
  const style = {
    height: count * rowHeight, paddingTop: first * rowHeight, '--row-h': `${rowHeight}px`,
  } as CSSProperties;
  return (
    <div className="list vlist" tabIndex={0} role="tree" aria-label={label} onScroll={measure} onKeyDown={onKeyDown}
      aria-activedescendant={at >= first && at < last ? `${base}${at}` : undefined}
      ref={(el) => {
        box.current = el;
        if (typeof ref === 'function') return ref(el);
        if (ref) ref.current = el;
        return undefined;
      }}>
      <div className="vlist-body" ref={body} style={style}>{rows}</div>
    </div>
  );
}
