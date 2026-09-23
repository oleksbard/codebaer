import type { PointerEvent as ReactPointerEvent } from 'react';
import { Kbd } from '../ui/Kbd';
import { palette } from './controller';
import { notify, S } from './store';

export function Header() {
  // the window has no title bar of its own, so this row is what drags it
  return (
    <header className="head" data-tauri-drag-region>
      <button type="button" className="cmd-field" onClick={() => void palette()}>
        <SearchIcon />
        <span className="txt">Search commands</span>
        <Kbd>⌘⇧P</Kbd>
      </button>
    </header>
  );
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4"
      strokeLinecap="round" aria-hidden="true">
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5 14 14" />
    </svg>
  );
}

export function Gutter() {
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const g = e.currentTarget;
    g.setPointerCapture(e.pointerId);
    const box = g.parentElement!;
    const left = box.querySelector('.side')?.getBoundingClientRect().left ?? 0;
    // the frame's content box is what the CSS min() takes 100% of, so the two caps agree
    const max = box.clientWidth - 400;
    let w = 0;
    let frame = 0;
    const move = (ev: PointerEvent) => {
      w = Math.max(180, Math.min(max, Math.round(ev.clientX - left)));
      S.sideWidth = w;
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; notify(); });
    };
    const done = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      notify();
      g.removeEventListener('pointermove', move);
      g.removeEventListener('pointerup', done);
      g.removeEventListener('pointercancel', done);
      if (w) localStorage.setItem('codebaer.sideWidth', String(w));
    };
    g.addEventListener('pointermove', move);
    g.addEventListener('pointerup', done);
    g.addEventListener('pointercancel', done);
  };
  return <div className="gutter" id="gutter" onPointerDown={onPointerDown} />;
}
