import { coreState } from '#core/state';
import { commentsState } from '#features/comments/state';
import { filesState } from '#features/files/state';
import { gitOpsState } from '#features/git-ops/state';
import { orphansState } from '#features/orphans/state';
import { reviewState } from '#features/review/state';
import { settingsState } from '#features/settings/state';
import { tasksState } from '#features/tasks/state';
import { terminalsState } from '#features/terminals/state';
import { S, type State } from '#kernel/store';

declare module '#kernel/store' {
  interface State {
    sidebarHidden: boolean;
    sideWidth: number | null;
  }
}

const storedWidth = localStorage.getItem('codebaer.sideWidth');

// typed as the whole State less the kernel's own fields, so a feature that declares a field and forgets
// its initial value fails tsc here
const initial: Omit<State, 'palette' | 'confirm' | 'prompt' | 'toasts' | 'chord'> = {
  ...coreState(), ...gitOpsState(), ...reviewState(), ...commentsState(), ...terminalsState(), ...filesState(),
  ...orphansState(), ...settingsState(), ...tasksState(),
  sidebarHidden: localStorage.getItem('codebaer.sidebarHidden') === 'true',
  sideWidth: storedWidth ? Math.max(180, Number(storedWidth)) : null,
};
Object.assign(S, initial);
