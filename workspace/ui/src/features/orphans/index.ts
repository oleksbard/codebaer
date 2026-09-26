import { defineFeature } from '#kernel/registry';
import { S } from '#kernel/store';
import { findOrphans } from './actions';
import { OrphansOverlay } from './OrphansDialog';

export const orphans = defineFeature({
  id: 'orphans',
  commands: [{ id: 'orphans.find', run: findOrphans }],
  events: { 'menu-orphans': { run: () => void findOrphans(), idleOnly: true } },
  overlays: [{ id: 'orphans', isOpen: () => S.orphans !== null, component: OrphansOverlay }],
});

export { findOrphans } from './actions';
