import type { PointerEvent as ReactPointerEvent } from 'react';
import { Button } from '../ui/Button';
import { Kbd } from '../ui/Kbd';
import { Spinner } from '../ui/Spinner';
import { cancel, checkout, palette } from './controller';
import { notify, S, useApp } from './store';

export function Header() {
  useApp();
  return (
    <header className="head">
      <div className="brand"><img src="/icon.png" alt="" />CodeBär</div>
      <span className="repo">{S.root ?? ''}</span>
      <div className="right"><Button variant="ghost" onClick={() => void palette()}>Commands <Kbd>⌘⇧P</Kbd></Button></div>
    </header>
  );
}

export function Footer() {
  useApp();
  const st = S.status;
  const branch = !st ? '…' : st.head === null ? 'no commits' : st.branch ?? st.head.slice(0, 8);
  const ab = !st ? null : st.upstream
    ? <span className="ab">
        <span className={st.ahead ? 'on' : ''}>↑{st.ahead}</span>
        <span className={st.behind ? 'on' : ''}>↓{st.behind}</span>
      </span>
    : <span>no upstream</span>;
  return (
    <footer className="foot">
      <div className="branch">
        <button type="button" title="Checkout to…" onClick={() => void checkout()}><span>{branch}</span>{ab}</button>
        {S.busy && <Spinner />}
        {S.busy && S.cancellable && <Button variant="ghost" onClick={() => void cancel()}>Cancel</Button>}
      </div>
    </footer>
  );
}

export function Gutter() {
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const g = e.currentTarget;
    g.setPointerCapture(e.pointerId);
    let w = 0;
    let frame = 0;
    const move = (ev: PointerEvent) => {
      w = Math.max(180, Math.min(globalThis.innerWidth - 400, Math.round(ev.clientX)));
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
