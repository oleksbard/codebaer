import { logError } from '#ipc/log';
import * as pty from '#ipc/terminal';
import { defineFeature } from '#kernel/registry';
import { S } from '#kernel/store';
import {
  closeTerminal, findInTerminal, killTerminal, newTerminal, onTerminal, showTerminals,
} from './sessions';
import * as term from './xterm';

export const terminals = defineFeature({
  id: 'terminals',
  commands: [
    {
      id: 'terminals.new',
      label: 'Terminal: New Terminal',
      run: () => newTerminal(),
      more: () => [
        ...(S.termMenu?.shells ?? []).map((sh) => ({
          label: `Terminal: New ${sh.name}`,
          run: () => newTerminal({ t: 'Shell', path: sh.path }),
        })),
        ...(S.termMenu?.commands ?? []).map((c) => ({
          label: `Terminal: Run ${c}`,
          run: () => newTerminal({ t: 'Command', argv0: c }),
        })),
      ],
    },
    { id: 'terminals.find', label: 'Terminal: Find…', run: findInTerminal },
    {
      id: 'terminals.findNext',
      label: 'Terminal: Find Next',
      run: () => onTerminal((id) => term.find(id, S.termFind)),
    },
    {
      id: 'terminals.findPrev',
      label: 'Terminal: Find Previous',
      run: () => onTerminal((id) => term.find(id, S.termFind, true)),
    },
    { id: 'terminals.clear', label: 'Terminal: Clear Buffer', run: () => onTerminal(term.clear) },
    { id: 'terminals.larger', label: 'Terminal: Larger Text', run: () => term.setFontSize(term.fontSize() + 1) },
    { id: 'terminals.smaller', label: 'Terminal: Smaller Text', run: () => term.setFontSize(term.fontSize() - 1) },
    { id: 'terminals.kill', label: 'Terminal: Kill Session', run: () => onTerminal(killTerminal) },
    { id: 'terminals.close', label: 'Terminal: Close Session', run: () => onTerminal(closeTerminal) },
    { id: 'terminals.show', run: () => void showTerminals() },
    { id: 'terminals.focus', run: () => { if (S.activeTerm !== null) term.focus(S.activeTerm); } },
  ],
  onRepoChange: {
    // the badge already compares against the new root; this only freshens folders up to a sweep old
    reset: () => { pty.checkCwd().catch((e: unknown) => logError(e, 'terminal folders')); },
  },
});

export { Terminals, TerminalRail } from './Terminals';
export {
  agentOf, homeFrom, isExited, isTask, outsideRepo, shortCwd, statusLabel, termLabels, terminalsOf,
} from './status';
export {
  closeTerminal, connectTerminals, killTerminal, onTermEvent, selectTerminal, showTerminals, taskEvents,
} from './sessions';
export { fit, focus, mount, reset, restoreOrphan, retheme, size } from './xterm';
