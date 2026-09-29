import { defineFeature } from '#kernel/registry';
import { S } from '#kernel/store';
import { openSettings, toggleDiffLayout } from './settings';
import { SettingsDialog } from './SettingsDialog';

export const settings = defineFeature({
  id: 'settings',
  // no argument: openSettings takes a section, and the default is the one both of these open
  commands: [
    { id: 'settings.open', label: 'Settings…', run: () => openSettings() },
    // the review feature's layout button, which cannot import this feature
    { id: 'settings.toggleDiffLayout', run: toggleDiffLayout },
  ],
  events: { 'menu-settings': { run: () => void openSettings(), idleOnly: true } },
  overlays: [{ id: 'settings', isOpen: () => S.settingsOpen, component: SettingsDialog }],
});

export { commandTitle, HIDDEN_TASK_MS, inMenu, scriptHidden } from './commands';
export { loadCommands, loadSettings, openSettings } from './settings';
