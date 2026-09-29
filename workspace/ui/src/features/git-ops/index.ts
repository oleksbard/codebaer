import { defineFeature } from '#kernel/registry';
import { S } from '#kernel/store';
import { onStatus } from './auto-fetch';
import { checkout, commit, createBranch, focusCommit, network, stash, unstash } from './git-ops';

const hasHead = (): boolean => (S.status?.head ?? null) !== null;
/** git refuses to stash or unstash while a path is unmerged. */
const canStash = (): boolean => hasHead() && !S.status?.files.some((f) => f.conflicted);

export const gitOps = defineFeature({
  id: 'git-ops',
  commands: [
    { id: 'git.focusCommit', label: 'Git: Commit', hintOf: 'git.commit', run: focusCommit },
    { id: 'git.commit', run: commit },
    { id: 'git.push', label: 'Git: Push', run: () => network('push') },
    { id: 'git.pull', label: 'Git: Pull', run: () => network('pull') },
    { id: 'git.fetch', label: 'Git: Fetch', run: () => network('fetch') },
    { id: 'git.checkout', label: 'Git: Checkout to…', run: checkout },
    { id: 'git.createBranch', label: 'Git: Create Branch…', run: createBranch },
    { id: 'git.stash', label: 'Git: Stash All', when: canStash, run: () => stash('all') },
    { id: 'git.stashChanges', label: 'Git: Stash Changes', when: canStash, run: () => stash('unstaged') },
    { id: 'git.stashStaged', label: 'Git: Stash Staged', when: canStash, run: () => stash('staged') },
    { id: 'git.unstash', label: 'Git: Unstash…', when: canStash, run: unstash },
  ],
  aiUses: [{
    command: 'ai_commit_message', label: 'Writes the commit message from the staged diff',
    icon: 'lucide:git-commit-horizontal',
  }, {
    command: 'ai_stash_description', label: 'Describes what each stash holds', icon: 'lucide:archive',
  }],
  onRefresh: onStatus,
});

export { startAutoFetch } from './auto-fetch';
export { CommitBox } from './CommitBox';
export { stash, unstash } from './git-ops';
