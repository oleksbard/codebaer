import { defineFeature, openPalette, type CommandIds } from '#kernel/registry';
import { refs } from '#kernel/store';
import { commandIcons } from '#features/command-icons';
import { comments } from '#features/comments';
import { files } from '#features/files';
import { gitOps } from '#features/git-ops';
import { orphans } from '#features/orphans';
import { repos } from '#features/repos';
import { review } from '#features/review';
import { settings } from '#features/settings';
import { tasks } from '#features/tasks';
import { terminals } from '#features/terminals';
import { toggleSidebar } from './actions';
import { core } from '#core/feature';

const app = defineFeature({
  id: 'app',
  commands: [
    { id: 'app.palette', run: openPalette },
    { id: 'app.toggleSidebar', run: toggleSidebar },
    { id: 'app.focusList', run: () => refs.list?.focus() },
  ],
});

/** Palette order, hook order and repo-change order follow this list. */
export const FEATURES = [
  core, gitOps, review, comments, repos, terminals, files, orphans, settings, commandIcons, tasks, app,
] as const;
export type CommandId = CommandIds<typeof FEATURES>;
