import { closeRepo, pickRepo } from '#core/session';
import { defineFeature } from '#kernel/registry';
import { S } from '#kernel/store';
import { closeRepoPrefs, openRepoPrefs } from './actions';
import { RepoPrefsOverlay } from './RepoPrefsDialog';

const hasRepo = () => S.root !== null;

export const repos = defineFeature({
  id: 'repos',
  // read on call, not on load: the terminals import this feature, and tests that load them mock #core/session
  // with only what they use
  commands: [
    { id: 'repos.pick', label: 'Open Repository…', run: () => pickRepo() },
    { id: 'repos.preferences', label: 'Repository Preferences…', when: hasRepo, run: openRepoPrefs },
    { id: 'repos.close', label: 'Close Repository', when: hasRepo, run: () => closeRepo() },
  ],
  events: { 'menu-open-folder': { run: () => void pickRepo(), idleOnly: true } },
  overlays: [{ id: 'repo-prefs', isOpen: () => S.repoPrefs !== null, component: RepoPrefsOverlay }],
  onRepoChange: { reset: closeRepoPrefs },
  aiUses: [{
    command: 'ai_repo_icons', label: 'Picks an icon for each repository in the switcher', icon: 'lucide:folder-git-2',
  }],
});

export { avatarOf } from './avatar';
export { NoGit } from './NoGit';
export { NoRepo } from './NoRepo';
export { RepoAvatar } from './RepoAvatar';
export { RepoSwitcher } from './RepoSwitcher';
