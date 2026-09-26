import { defineFeature } from '#kernel/registry';
import { refs, S } from '#kernel/store';
import { loadFiles, quickOpen, showFiles } from './files';

export const files = defineFeature({
  id: 'files',
  commands: [
    { id: 'files.quickOpen', run: quickOpen },
    { id: 'files.show', run: () => { void showFiles().then(() => refs.list?.focus()); } },
  ],
  onRefresh: async () => { if (S.tab === 'files') await loadFiles(); },
  onRepoChange: { reset: () => S.ignoredKids.clear() },
});

export { FilesList } from './FilesTree';
export { showFiles } from './files';
