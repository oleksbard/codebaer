import { Fragment, useState, type CSSProperties } from 'react';
import { DropdownMenu } from 'radix-ui';
import { split } from '#core/model';
import { openRepo, pickRepo } from '#core/session';
import { git, type Recent } from '#ipc/git';
import { keyLabel, matches } from '#kernel/keymap';
import { useApp } from '#kernel/store';
import { Kbd } from '#ui/Kbd';
import { avatars, forgetAvatars, hueOf } from './avatar';

const STAR = 'M8 2.05 9.47 6.28 13.94 6.37 10.38 9.07 11.67 13.36 8 10.8 4.33 13.36 5.62 9.07 2.06 6.37 6.53 6.28Z';

function RepoAvatar({ path, code }: { path: string; code: string | undefined }) {
  const style = { '--hue': `var(--hue-${hueOf(path)})` } as CSSProperties;
  return <span className="repo-avatar" style={style} aria-hidden="true">{code}</span>;
}

function RepoLabel({ repo, code }: { repo: Recent; code: string | undefined }) {
  return (
    <span className="repo-label">
      <RepoAvatar path={repo.path} code={code} />
      <span className="name">{repo.name}</span>
      <span className="dash">-</span>
      <span className="path">{repo.label}</span>
    </span>
  );
}

function Star({ repo, onToggle }: { repo: Recent; onToggle(): void }) {
  const what = repo.favorite ? 'Remove from favorites' : 'Add to favorites';
  return (
    <button type="button" className="repo-star" tabIndex={-1} aria-label="Favorite" aria-pressed={repo.favorite}
      title={`${what} (${keyLabel('repos.favorite')})`}
      // Radix highlights the row that has focus, so the row keeps it
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => { e.stopPropagation(); onToggle(); }}>
      <svg viewBox="0 0 16 16" width="14" height="14" stroke="currentColor" strokeWidth="1.4"
        strokeLinejoin="round" aria-hidden="true">
        <path d={STAR} />
      </svg>
    </button>
  );
}

export function RepoSwitcher() {
  const s = useApp();
  const [recent, setRecent] = useState<Recent[]>([]);
  if (!s.root) return null;
  const root = s.root;
  const name = s.title ?? split(root)[1];
  const codes = avatars([{ path: root, name }, ...recent]);
  const load = async () => {
    const list = await git.recentRepos();
    // the only point where every repo the switcher can show is known
    forgetAvatars([root, ...list.map((r) => r.path)]);
    setRecent(list);
  };
  const favorite = async (r: Recent) => setRecent(await git.favoriteRepo(r.path, !r.favorite));
  return (
    <DropdownMenu.Root onOpenChange={(open) => { if (open) void load(); }}>
      <DropdownMenu.Trigger asChild>
        <button type="button" className="repo-trigger" title={`${s.rootLabel ?? root} - switch project`}>
          <RepoAvatar path={root} code={codes.get(root)} />
          <span className="name">{name}</span>
          <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6"
            strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M4 6l4 4 4-4" />
          </svg>
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="menu repo-menu" align="start" sideOffset={4}>
          <DropdownMenu.Item className="menu-item" onSelect={() => void pickRepo()}>
            Open Folder…<span className="detail"><Kbd>{keyLabel('repos.pick')}</Kbd></span>
          </DropdownMenu.Item>
          {recent.map((r, i) => (
            // one keyed list across both groups, so a row that changes group is moved rather than remounted
            <Fragment key={r.path}>
              {r.favorite !== recent[i - 1]?.favorite && <DropdownMenu.Separator className="menu-sep" />}
              <DropdownMenu.Item className="menu-item repo-item" onSelect={() => void openRepo(r.path)}
                onKeyDown={(e) => {
                  if (!matches(e, 'repos.favorite')) return;
                  e.preventDefault();
                  void favorite(r);
                }}>
                <RepoLabel repo={r} code={codes.get(r.path)} />
                <Star repo={r} onToggle={() => void favorite(r)} />
              </DropdownMenu.Item>
            </Fragment>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
