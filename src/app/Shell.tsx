import { useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { DropdownMenu } from 'radix-ui';
import { git, type Recent } from '../git';
import { split } from '../model';
import { Button } from '../ui/Button';
import { IconButton } from '../ui/IconButton';
import { Kbd } from '../ui/Kbd';
import { Spinner } from '../ui/Spinner';
import { cancel, checkout, network, openRepo, palette, pickRepo } from './controller';
import { notify, S, useApp } from './store';
import { TermStatus } from './Terminals';

function RepoLabel({ name, path }: { name: string; path: string }) {
  return (
    <span className="repo-label">
      <span className="name">{name}</span>
      <span className="dash">-</span>
      <span className="path">{path}</span>
    </span>
  );
}

function Repo() {
  const [recent, setRecent] = useState<Recent[]>([]);
  if (!S.root) return null;
  return (
    <span className="repo">
      <RepoLabel name={S.title ?? split(S.root)[1]} path={S.root} />
      <DropdownMenu.Root onOpenChange={(open) => { if (open) void git.recentRepos().then(setRecent); }}>
        <DropdownMenu.Trigger asChild>
          <button type="button" className="ico repo-switch" title="Switch project" aria-label="Switch project">
            ⇄
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content className="menu repo-menu" align="start" sideOffset={6}>
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
    </span>
  );
}

export function Header() {
  useApp();
  return (
    <header className="head">
      <img className="brand" src="/icon.png" alt="" />
      <Repo />
      <div className="right">
        <Button variant="ghost" onClick={() => void palette()}>Commands <Kbd>⌘⇧P</Kbd></Button>
      </div>
    </header>
  );
}

const commits = (n: number) => `${n} commit${n === 1 ? '' : 's'}`;

function RemoteActions() {
  const st = S.status;
  if (!st) return null;
  // git reports no ahead count without an upstream, and push is the thing that creates one,
  // so an untracked branch offers push rather than hiding it until it can be counted
  const push = st.upstream === null ? st.head !== null : st.ahead > 0 && st.behind === 0;
  return (
    <span className="remote">
      {st.upstream !== null &&
        <IconButton label="Fetch from remote" disabled={S.busy} onClick={() => void network('fetch')}>↻</IconButton>}
      {st.behind > 0 &&
        <IconButton label={`Pull ${commits(st.behind)}`}
          disabled={S.busy} onClick={() => void network('pull')}>⤓</IconButton>}
      {push &&
        <IconButton label={st.upstream === null ? 'Push and set upstream' : `Push ${commits(st.ahead)}`}
          disabled={S.busy} onClick={() => void network('push')}>⤒</IconButton>}
    </span>
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
        <RemoteActions />
        {S.busy && <Spinner />}
        {S.busy && S.cancellable && <Button variant="ghost" onClick={() => void cancel()}>Cancel</Button>}
      </div>
      {S.tab === 'terminals'
        ? <TermStatus />
        : S.open && S.blame &&
          <span className="blame" title="Last commit to touch the line under the cursor">{S.blame}</span>}
    </footer>
  );
}

// mirrors the activity-bar column in layout.css: clientX counts it, --side-w does not
export const ACT_W = 56;

export function Gutter() {
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const g = e.currentTarget;
    g.setPointerCapture(e.pointerId);
    let w = 0;
    let frame = 0;
    const move = (ev: PointerEvent) => {
      w = Math.max(180, Math.min(globalThis.innerWidth - 400 - ACT_W, Math.round(ev.clientX) - ACT_W));
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
