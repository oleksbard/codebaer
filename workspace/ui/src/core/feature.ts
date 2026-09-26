import { defineFeature } from '#kernel/registry';
import { notify, S } from '#kernel/store';
import { flush, openRepo, refresh, view } from './session';

export const core = defineFeature({
  id: 'core',
  commands: [
    { id: 'core.save', run: () => { if (S.open?.dirty) void flush(); } },
    { id: 'core.focusEditor', run: () => view.focus() },
    { id: 'core.escape', run: () => { if (S.open?.badge) { S.open.badge = null; notify(); } } },
  ],
  events: {
    'repo-changed': { run: () => void refresh() },
    'open-repo': { run: (path) => void openRepo(String(path)) },
    'menu-open-recent': { run: (path) => void openRepo(String(path)), idleOnly: true },
  },
});
