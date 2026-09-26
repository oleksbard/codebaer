import { guarded } from '#core/session';
import { git } from '#ipc/git';
import { defineFeature } from '#kernel/registry';
import { S } from '#kernel/store';
import { onStatus } from './auto-fetch';
import { checkout, commit, createBranch, focusCommit, network, stashPop } from './git-ops';

const hasHead = (): boolean => S.status?.head !== null;

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
    { id: 'git.stash', label: 'Git: Stash', when: hasHead, run: () => guarded('stashPush', () => git.stashPush()) },
    { id: 'git.stashPop', label: 'Git: Pop Stash', when: hasHead, run: stashPop },
  ],
  aiUses: [{
    command: 'ai_commit_message', label: 'Writes the commit message from the staged diff',
    icon: 'lucide:git-commit-horizontal',
  }],
  onRefresh: onStatus,
});

export { startAutoFetch } from './auto-fetch';
export { CommitBox } from './CommitBox';
