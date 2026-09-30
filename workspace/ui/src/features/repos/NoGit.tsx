import { openRepo } from '#core/session';
import { keyLabel } from '#kernel/keymap';
import { run } from '#kernel/registry';
import { useApp } from '#kernel/store';
import { Button } from '#ui/Button';
import { Kbd } from '#ui/Kbd';

const NEEDS_GIT = 'Terminals and tasks work here, but the review, commits, branches and the Files tab need git.';

/** The main pane for a folder open without git. Nothing here runs git init unasked. */
export function NoGit() {
  const s = useApp();
  const root = s.root;
  if (root === null) return null;
  const name = s.rootLabel ?? root;
  return (
    <div className="blank no-repo no-git">
      <div>
        <img src="/logo.png" alt="" />
        {s.gitMissing === null ? (
          <>
            <h2>No git repository</h2>
            <p>{name} is not a git repository. {NEEDS_GIT} A repository in the project folder is advised.</p>
          </>
        ) : (
          <>
            <h2>git is not installed</h2>
            <p>CodeBär could not run git on this machine. {NEEDS_GIT} Install git, then open the folder again.</p>
            <p className="dim">{s.gitMissing}</p>
          </>
        )}
        <div className="no-git-actions">
          {s.gitMissing === null
            ? <Button variant="primary" onClick={() => run('git.init')}>Init Repository</Button>
            : <Button variant="primary" onClick={() => void openRepo(root)}>Open Again</Button>}
          <Button onClick={() => run('terminals.new')}>New Terminal<Kbd>{keyLabel('terminals.new')}</Kbd></Button>
        </div>
      </div>
    </div>
  );
}
