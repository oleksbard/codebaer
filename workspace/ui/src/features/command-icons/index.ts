import { defineFeature } from '#kernel/registry';

// the command menu, the Commands pane and the terminal rail ask for the icons they show, and the repo switcher
// asks through iconAsker; nothing here has a key or a palette entry
export const commandIcons = defineFeature({
  id: 'command-icons',
  aiUses: [{
    command: 'ai_command_icons', label: 'Picks an icon for each command in the command menu, and for each terminal',
    icon: 'lucide:shapes',
  }],
});

export { CommandIcon, GlyphSvg, SetIcon } from './CommandIcon';
export { ensureIcons, glyph, iconAsker, pickedGlyph, type Glyph } from './icons';
export { IconPicker } from './IconPicker';
