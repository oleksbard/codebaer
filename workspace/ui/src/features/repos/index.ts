import { pickRepo } from '#core/session';
import { defineFeature } from '#kernel/registry';

export const repos = defineFeature({
  id: 'repos',
  commands: [{ id: 'repos.pick', label: 'Open Repository…', run: pickRepo }],
  events: { 'menu-open-folder': { run: () => void pickRepo(), idleOnly: true } },
});

export { RepoSwitcher } from './RepoSwitcher';
