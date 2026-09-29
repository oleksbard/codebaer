import { useEffect, useRef, useState } from 'react';
import { avatarOf, RepoAvatar } from '#features/repos';
import { git, type Recent } from '#ipc/git';
import { logError } from '#ipc/log';
import type { Info } from '#ipc/terminal';
import { useApp, type DeepReadonly } from '#kernel/store';
import { homeFrom, outsideRepo, placeOf } from './status';

/** How close the pointer comes before the badge fades, so the text under it can be read and selected. */
const REACH = 24;

export function Away() {
  return (
    <svg className="away" viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9.5 2.5h4v4M13.5 2.5 8 8M11.5 10v3.5h-9v-9H6" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg className="folder" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor"
      strokeWidth="1.3" strokeLinejoin="round" aria-hidden="true">
      <path d="M1.75 4.25c0-.83.67-1.5 1.5-1.5h2.9l1.6 1.75h4.99c.83 0 1.5.67 1.5 1.5v5.75c0 .83-.67 1.5-1.5 1.5H3.25
        c-.83 0-1.5-.67-1.5-1.5z" />
    </svg>
  );
}

/** Over the terminal's top left while its session works outside the open repo: the recent repo that holds
 *  its folder, else the folder. It lets the pointer through and fades as the pointer nears it. */
export function OutsideBadge({ session }: { session: DeepReadonly<Info> }) {
  const root = useApp().root;
  const away = outsideRepo(session, root);
  const [recents, setRecents] = useState<Recent[]>([]);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!away) return;
    let live = true;
    git.recentRepos().then((list) => { if (live) setRecents(list); }, (e: unknown) => logError(e, 'recent repos'));
    return () => { live = false; };
  }, [away, root]);

  useEffect(() => {
    const el = ref.current;
    const frame = el?.parentElement;
    if (!el || !frame) return;
    // in capture, since xterm stops the events a program that reads the mouse gets
    const move = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      el.toggleAttribute('data-near', e.clientX < r.right + REACH && e.clientY < r.bottom + REACH);
    };
    const leave = () => el.removeAttribute('data-near');
    frame.addEventListener('pointermove', move, true);
    frame.addEventListener('pointerleave', leave);
    return () => {
      frame.removeEventListener('pointermove', move, true);
      frame.removeEventListener('pointerleave', leave);
    };
  }, [away]);

  if (!away) return null;
  const place = placeOf(session.cwd, homeFrom(session.cwd), recents);
  return (
    <div className="term-outside" ref={ref}>
      <span className="sr-only">Outside the repo, in </span>
      {place.repo ? <RepoAvatar path={place.repo.path} avatar={avatarOf(place.repo)} /> : <FolderIcon />}
      <span className="where">
        {place.lead && <span className="lead">{place.lead}</span>}
        <span className="name">{place.name}</span>
        {place.tail && <span className="tail">{place.tail}</span>}
      </span>
      <Away />
    </div>
  );
}
