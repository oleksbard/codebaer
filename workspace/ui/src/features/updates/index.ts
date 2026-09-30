import { defineFeature } from '#kernel/registry';
import { S } from '#kernel/store';
import { checkForUpdates, restartToUpdate } from './updates';

export const updates = defineFeature({
  id: 'updates',
  commands: [
    { id: 'updates.check', label: 'Check for Updates…', when: () => S.canUpdate, run: () => void checkForUpdates() },
    {
      id: 'updates.restart', label: 'Restart to Update', when: () => S.update !== null,
      run: () => void restartToUpdate(),
    },
  ],
  events: { 'menu-check-updates': { run: () => void checkForUpdates(), idleOnly: true } },
});

export { checkForUpdates, restartedIntoUpdate, startUpdates } from './updates';
export { UpdatePill } from './UpdatePill';
