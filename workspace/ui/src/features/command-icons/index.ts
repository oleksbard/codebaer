import { defineFeature } from '#kernel/registry';

// the command menu and the Commands pane ask for the icons they show; nothing here has a key or a palette entry
export const commandIcons = defineFeature({
  id: 'command-icons',
  aiUses: [{
    command: 'ai_command_icons', label: 'Picks an icon for each command in the command menu', icon: 'lucide:shapes',
  }],
});

export { CommandIcon, SetIcon } from './CommandIcon';
export { ensureIcons } from './icons';
export { IconPicker } from './IconPicker';
