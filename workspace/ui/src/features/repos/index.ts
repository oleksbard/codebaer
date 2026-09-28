import { pickRepo } from '#core/session';
import { defineFeature } from '#kernel/registry';

export const repos = defineFeature({
  id: 'repos',
  commands: [
    { id: 'repos.pick', label: 'Open Repository…', run: pickRepo },
    // only a key of the switcher's rows, which know the repo and handle it themselves
    { id: 'repos.favorite', run: () => {} },
  ],
  events: { 'menu-open-folder': { run: () => void pickRepo(), idleOnly: true } },
});

export { RepoSwitcher } from './RepoSwitcher';
