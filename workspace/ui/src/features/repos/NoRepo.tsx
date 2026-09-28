import { useEffect, useState } from 'react';
import { openRepo, pickRepo } from '#core/session';
import type { Recent } from '#ipc/git';
import { keyLabel } from '#kernel/keymap';
import { Button } from '#ui/Button';
import { Kbd } from '#ui/Kbd';
import { lastOpened } from './actions';
import { avatars } from './avatar';
import { RepoAvatar } from './RepoAvatar';

/** The main pane while no repo is open: a new folder, or the repo that was open last. */
export function NoRepo() {
  const [last, setLast] = useState<Recent | null>(null);
  useEffect(() => {
    let live = true;
    void lastOpened().then((r) => { if (live) setLast(r); });
    return () => { live = false; };
  }, []);
  return (
    <div className="blank no-repo">
      <div>
        <img src="/logo.png" alt="" />
        <h2>No repository open</h2>
        <p>Open a folder with a git repository to review what an agent changed in it.</p>
        <Button variant="primary" className="no-repo-pick" onClick={() => void pickRepo()}>
          Open Folder…<Kbd>{keyLabel('repos.pick')}</Kbd>
        </Button>
        {last && (
          <div className="no-repo-last">
            <span id="no-repo-last">Last opened</span>
            <button type="button" className="no-repo-card" aria-describedby="no-repo-last"
              onClick={() => void openRepo(last.path)}>
              <RepoAvatar path={last.path} avatar={avatars([last]).get(last.path)} favorite={last.favorite} large />
              <span className="no-repo-text">
                <span className="name">{last.name}</span>
                <span className="path">{last.label}</span>
              </span>
              <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6"
                strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M6 4l4 4-4 4" />
              </svg>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
