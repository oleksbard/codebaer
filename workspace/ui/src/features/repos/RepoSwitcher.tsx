import { useState, type CSSProperties } from 'react';
import { DropdownMenu } from 'radix-ui';
import { split } from '#core/model';
import { openRepo, pickRepo } from '#core/session';
import { git, type Recent } from '#ipc/git';
import { keyLabel } from '#kernel/keymap';
import { useApp } from '#kernel/store';
import { avatars, forgetAvatars, hueOf } from './avatar';

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
            Open Folder…<span className="detail">{keyLabel('repos.pick')}</span>
          </DropdownMenu.Item>
          {recent.length > 0 && <DropdownMenu.Separator className="menu-sep" />}
          {recent.map((r) => (
            <DropdownMenu.Item key={r.path} className="menu-item" onSelect={() => void openRepo(r.path)}>
              <RepoLabel repo={r} code={codes.get(r.path)} />
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
