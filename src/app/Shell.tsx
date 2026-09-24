import { useState, type PointerEvent as ReactPointerEvent } from 'react';
import { DropdownMenu } from 'radix-ui';
import { git, type Recent } from '../git';
import { split } from '../model';
import { Kbd } from '../ui/Kbd';
import { openRepo, palette, pickRepo } from './controller';
import { notify, S, useApp } from './store';

export function Header() {
  useApp();
  // the window has no title bar of its own, so this row is what drags it
  return (
    <header className="head" data-tauri-drag-region>
      <RepoSwitcher />
      <button type="button" className="cmd-field" onClick={() => void palette()}>
        <SearchIcon />
        <span className="txt">Search commands</span>
        <Kbd>⌘⇧P</Kbd>
      </button>
    </header>
  );
}

function RepoLabel({ name, path }: { name: string; path: string }) {
  return (
    <span className="repo-label">
      <span className="name">{name}</span>
      <span className="dash">-</span>
      <span className="path">{path}</span>
    </span>
  );
}

function RepoSwitcher() {
  const [recent, setRecent] = useState<Recent[]>([]);
  if (!S.root) return null;
  return (
    <DropdownMenu.Root onOpenChange={(open) => { if (open) void git.recentRepos().then(setRecent); }}>
      <DropdownMenu.Trigger asChild>
        <button type="button" className="repo-trigger" title={`${S.rootLabel ?? S.root} - switch project`}>
          <span className="name">{S.title ?? split(S.root)[1]}</span>
          <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6"
            strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M4 6l4 4 4-4" />
          </svg>
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="menu repo-menu" align="start" sideOffset={4}>
          <DropdownMenu.Item className="menu-item" onSelect={() => void pickRepo()}>
            Open Folder…<span className="detail">⌘O</span>
          </DropdownMenu.Item>
          {recent.length > 0 && <DropdownMenu.Separator className="menu-sep" />}
          {recent.map((r) => (
            <DropdownMenu.Item key={r.path} className="menu-item" onSelect={() => void openRepo(r.path)}>
              <RepoLabel name={r.name} path={r.label} />
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
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
