import type { Binding } from '#kernel/keymap';
import type { CommandId } from '#app/features';

/** A row without `in: 'any'` never fires in a terminal: Escape, F7, Cmd-K, Cmd-N, Cmd-S and Cmd-Y are keys
 *  vim, top and the agent CLIs expect to receive themselves. Where a command has two rows, labels show the
 *  first; the palette shows the first that is not local. */
export const MAC: readonly Binding<CommandId>[] = [
  { keys: 'Alt+F5', command: 'review.nextHunk' },
  { keys: 'Alt+Shift+F5', command: 'review.prevHunk' },
  { keys: 'F7', command: 'review.nextHunk' },
  { keys: 'Shift+F7', command: 'review.prevHunk' },
  { keys: 'Mod+Y', command: 'review.accept' },
  { keys: 'Mod+Shift+Y', command: 'review.stageFile' },
  { keys: 'Mod+Alt+Y', command: 'review.stageAll' },
  { keys: 'Mod+N', command: 'review.reject' },
  { keys: 'Mod+Shift+N', command: 'review.discardFile' },
  { keys: 'Mod+Shift+]', command: 'review.nextFile' },
  { keys: 'Mod+Shift+[', command: 'review.prevFile' },
  // in the order the chord hint lists them
  { keys: 'Mod+K Mod+Alt+S', command: 'review.accept' },
  { keys: 'Mod+K Mod+R', command: 'review.reject' },
  { keys: 'Mod+K Mod+N', command: 'review.unstageHunk' },
  { keys: 'Mod+K Mod+Alt+C', command: 'comments.start' },
  // the comment box cancels itself on Escape; the global one would also dismiss the changed-on-disk badge
  { keys: 'Escape', command: 'core.escape', notIn: ['comment'], passThrough: true },
  { keys: 'Ctrl+Shift+G', command: 'git.focusCommit' },
  { keys: 'Mod+S', command: 'core.save' },
  { keys: 'Mod+P', command: 'files.quickOpen', in: 'any' },
  { keys: 'Mod+Shift+P', command: 'app.palette', in: 'any' },
  { keys: 'Mod+B', command: 'app.toggleSidebar', in: 'any' },
  { keys: 'Mod+0', command: 'app.focusList', in: 'any' },
  { keys: 'Mod+1', command: 'core.focusEditor', in: 'any' },
  { keys: 'Mod+Shift+E', command: 'files.show', in: 'any' },
  { keys: 'Mod+Shift+T', command: 'terminals.show', in: 'any' },
  { keys: 'Mod+T', command: 'terminals.new', in: 'any' },
  { keys: 'Mod+2', command: 'terminals.focus', in: 'any' },
  // the commit box and the comment box handle these; the native menu (lib.rs) owns Cmd-, and Cmd-O
  { keys: 'Mod+Enter', command: 'git.commit', local: true },
  { keys: 'Mod+Enter', command: 'comments.save', local: true },
  { keys: 'Mod+Shift+Enter', command: 'comments.send', local: true },
  { keys: 'Mod+,', command: 'settings.open', local: true },
  { keys: 'Mod+O', command: 'repos.pick', local: true },
];
