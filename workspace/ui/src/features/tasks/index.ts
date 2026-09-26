import { taskEvents } from '#features/terminals';
import { defineFeature } from '#kernel/registry';
import { S } from '#kernel/store';
import { taskClosed, taskEnded, tasksListed, taskSpawned } from './runner';
import { TaskOverlay } from './TaskMenu';

taskEvents.hello = tasksListed;
taskEvents.spawned = taskSpawned;
taskEvents.ended = taskEnded;
taskEvents.closed = taskClosed;

// the menu, the Commands pane and the rail call the runner themselves; nothing here has a key or a palette entry
export const tasks = defineFeature({
  id: 'tasks',
  overlays: [{ id: 'tasks', isOpen: () => S.taskView !== null, component: TaskOverlay }],
});

export { TaskMenu } from './TaskMenu';
