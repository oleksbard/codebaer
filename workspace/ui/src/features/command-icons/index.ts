import { defineFeature } from '#kernel/registry';

// the command menu and the Commands pane ask for the icons they show; nothing here has a key or a palette entry
export const commandIcons = defineFeature({ id: 'command-icons' });

export { CommandIcon } from './CommandIcon';
export { ensureIcons } from './icons';
export { IconPicker } from './IconPicker';
