import { useEffect, useRef, useState, type CSSProperties } from 'react';

const STILL = globalThis.matchMedia('(prefers-reduced-motion: reduce)');
const TWEEN_MS = 700;
const BLOCKS = 5;

export type Block = 'add' | 'del' | 'none';

/** GitHub's five squares: split in proportion, one square per line under five lines, and a side
 *  with any lines keeps a square of its own. */
export function diffBlocks(added: number, removed: number): Block[] {
  const total = added + removed;
  const lit = Math.min(total, BLOCKS);
  let add = total ? Math.round((added / total) * lit) : 0;
  if (added && removed) add = Math.min(Math.max(add, 1), lit - 1);
  return Array.from({ length: BLOCKS }, (_, i) => (i < add ? 'add' : i < lit ? 'del' : 'none'));
}

/** Counts from whatever is on screen to `to`, so a change mid-count carries on from there. */
function useTween(to: number): number {
  const [shown, setShown] = useState(STILL.matches ? to : 0);
  const at = useRef(shown);
  useEffect(() => {
    const from = at.current;
    if (STILL.matches || from === to) { at.current = to; setShown(to); return; }
    const start = performance.now();
    let frame = 0;
    const step = (now: number): void => {
      const t = Math.min((now - start) / TWEEN_MS, 1);
      at.current = Math.round(from + (to - from) * (1 - (1 - t) ** 3));
      setShown(at.current);
      if (t < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [to]);
  return shown;
}

function Count({ value, sign, tone }: { value: number; sign: string; tone: 'add' | 'del' }) {
  const shown = useTween(value);
  const [last, setLast] = useState(value);
  const [changes, setChanges] = useState(0);
  if (value !== last) { setLast(value); setChanges(changes + 1); }
  // a new key remounts the span, which is what replays the bump
  return <span key={changes} className={`n ${tone}${changes ? ' bump' : ''}`}>{sign}{shown.toLocaleString()}</span>;
}

export function DiffStat({ added, removed }: { added: number; removed: number }) {
  const label = `${added.toLocaleString()} lines added, ${removed.toLocaleString()} removed`;
  return (
    <span className="diffstat" role="img" aria-label={label} title={label}>
      <Count value={added} sign="+" tone="add" />
      <Count value={removed} sign="−" tone="del" />
      <span className="blocks">
        {diffBlocks(added, removed).map((b, i) => (
          // keyed by colour too, so only a square that changes colour pops
          <i key={`${i}${b}`} className={`blk ${b}`} style={{ '--i': i } as CSSProperties} />
        ))}
      </span>
    </span>
  );
}
