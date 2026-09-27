import { defineFeature } from '#kernel/registry';
import { notify, S } from '#kernel/store';
import { flush, openRepo, quit, refresh, reload, view } from './session';

export const core = defineFeature({
  id: 'core',
  commands: [
    { id: 'core.save', label: 'File: Save', run: () => { if (S.open?.dirty) void flush(); } },
    { id: 'core.revert', label: 'File: Revert File', when: () => !!S.open?.dirty, run: () => void reload() },
    { id: 'core.focusEditor', run: () => view.focus() },
    { id: 'core.escape', run: () => { if (S.open?.badge) { S.open.badge = null; notify(); } } },
  ],
  events: {
    'repo-changed': { run: () => void refresh() },
    // not idleOnly: a dialog left open must not keep the app from quitting
    'quit-requested': { run: () => void quit() },
    'open-repo': { run: (path) => void openRepo(String(path)) },
    'menu-open-recent': { run: (path) => void openRepo(String(path)), idleOnly: true },
  },
});
