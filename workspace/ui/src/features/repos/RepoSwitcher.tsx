import { Fragment, useEffect, useState } from 'react';
import { DropdownMenu } from 'radix-ui';
import { closeRepo, openRepo, pickRepo } from '#core/session';
import { git, type Recent } from '#ipc/git';
import { keyLabel } from '#kernel/keymap';
import { useApp } from '#kernel/store';
import { inertOnClose, keepFocus } from '#ui/focus';
import { Kbd } from '#ui/Kbd';
import { openRepoPrefs, repoName } from './actions';
import { avatars, forgetAvatars, type Avatar } from './avatar';
import { ensureRepoIcons } from './icons';
import { RepoAvatar } from './RepoAvatar';

function RepoLabel({ repo, avatar }: { repo: Recent; avatar: Avatar | undefined }) {
  return (
    <span className="repo-label">
      <RepoAvatar path={repo.path} avatar={avatar} favorite={repo.favorite} />
      <span className="name">{repo.name}</span>
      {repo.favorite && <span className="sr-only">, favorite</span>}
      <span className="dash">-</span>
      <span className="path">{repo.label}</span>
    </span>
  );
}

export function RepoSwitcher() {
  const s = useApp();
  const [recent, setRecent] = useState<Recent[]>([]);
  const root = s.root;
  const name = root === null ? null : repoName(root, s.title);
  // asks again once the AI is turned on
  const ai = s.settings['general.headless-ai-provider'];
  // the backend lists the open repo too, which has its own place and its own name on the trigger
  const others = recent.filter((r) => r.path !== root);
  useEffect(() => {
    const listed = recent.filter((r) => r.path !== root);
    void ensureRepoIcons(root !== null && name !== null ? [{ path: root, name }, ...listed] : listed);
  }, [root, name, recent, ai]);
  const shown = avatars(root !== null && name !== null ? [{ path: root, name }, ...others] : others);
  const load = async () => {
    const list = await git.recentRepos();
    // the only point where every repo the switcher can show is known
    forgetAvatars([...(root === null ? [] : [root]), ...list.map((r) => r.path)]);
    setRecent(list);
  };
  return (
    <DropdownMenu.Root onOpenChange={(open) => { if (open) void load(); }}>
      <DropdownMenu.Trigger asChild>
        <button type="button" className="repo-trigger"
          title={root === null ? 'Open a project' : `${s.rootLabel ?? root} - switch project`}>
          {root !== null && <RepoAvatar path={root} avatar={shown.get(root)} />}
          <span className={root === null ? 'name none' : 'name'}>{name ?? 'No repository'}</span>
          <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6"
            strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M4 6l4 4 4-4" />
          </svg>
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="menu repo-menu" align="start" sideOffset={4} ref={inertOnClose}
          onCloseAutoFocus={keepFocus}>
          <DropdownMenu.Item className="menu-item" onSelect={() => void pickRepo()}>
            Open Folder…<span className="detail"><Kbd>{keyLabel('repos.pick')}</Kbd></span>
          </DropdownMenu.Item>
          {root !== null && (
            <DropdownMenu.Item className="menu-item" onSelect={() => void openRepoPrefs()}>
              Repository Preferences…
            </DropdownMenu.Item>
          )}
          {others.map((r, i) => (
            <Fragment key={r.path}>
              {r.favorite !== others[i - 1]?.favorite && <DropdownMenu.Separator className="menu-sep" />}
              <DropdownMenu.Item className="menu-item repo-item" onSelect={() => void openRepo(r.path)}>
                <RepoLabel repo={r} avatar={shown.get(r.path)} />
              </DropdownMenu.Item>
            </Fragment>
          ))}
          {root !== null && (
            <>
              <DropdownMenu.Separator className="menu-sep" />
              <DropdownMenu.Item className="menu-item" onSelect={() => void closeRepo()}>
                Close Repository
              </DropdownMenu.Item>
            </>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
