import { defineFeature } from '#kernel/registry';
import { S } from '#kernel/store';
import { openAiTools } from './actions';
import { AiToolsOverlay } from './AiToolsDialog';

export const aiTools = defineFeature({
  id: 'ai-tools',
  commands: [{ id: 'aiTools.open', label: 'Explore AI Tools…', run: openAiTools }],
  events: { 'menu-ai-tools': { run: openAiTools, idleOnly: true } },
  overlays: [{ id: 'ai-tools', isOpen: () => S.aiTools !== null, component: AiToolsOverlay }],
});

export { openAiTools } from './actions';
