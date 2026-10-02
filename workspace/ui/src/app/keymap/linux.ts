import type { Binding } from '#kernel/keymap';
import type { CommandId } from '#app/features';

/** The macOS table with Ctrl for Cmd, except where noted (docs/2026-09-25-linux-windows-support-design.md, 3.4).
 *  Plain Ctrl never fires in a terminal, where the shell and the agent CLIs own it: the commands that work there
 *  answer to Ctrl+Shift, as in a Linux terminal. With no menu bar, Settings, Open and Quit are keys of the app. */
export const LINUX: readonly Binding<CommandId>[] = [
  // no Alt+F5: GNOME takes it to unmaximize the window
  { keys: 'F7', command: 'review.nextHunk' },
  { keys: 'Shift+F7', command: 'review.prevHunk' },
  // CodeMirror's Ctrl+Y redo gives way; its Ctrl+Shift+Z still redoes
  { keys: 'Mod+Y', command: 'review.accept' },
  { keys: 'Mod+Shift+Y', command: 'review.stageFile' },
  { keys: 'Mod+Alt+Y', command: 'review.stageAll' },
  { keys: 'Mod+N', command: 'review.reject' },
  { keys: 'Mod+Shift+N', command: 'review.discardFile' },
  // CodeMirror's fold and unfold of one block give way; Ctrl+Alt+[ and ] still fold all
  { keys: 'Mod+Shift+]', command: 'review.nextFile' },
  { keys: 'Mod+Shift+[', command: 'review.prevFile' },
  { keys: 'Mod+Shift+A', command: 'review.allChanges' },
  // in the order the chord hint lists them
  { keys: 'Mod+K Mod+Alt+S', command: 'review.accept' },
  { keys: 'Mod+K Mod+R', command: 'review.reject' },
  { keys: 'Mod+K Mod+N', command: 'review.unstageHunk' },
  { keys: 'Mod+K Mod+Alt+C', command: 'comments.start' },
  { keys: 'Escape', command: 'core.escape', notIn: ['comment'], passThrough: true },
  // CodeMirror's findPrevious gives way; Shift+F3 still finds the previous match
  { keys: 'Ctrl+Shift+G', command: 'git.focusCommit' },
  { keys: 'Mod+S', command: 'core.save' },
  { keys: 'Mod+,', command: 'settings.open' },
  { keys: 'Mod+O', command: 'repos.pick' },
  // not in a terminal, where Ctrl+Q is XON
  { keys: 'Mod+Q', command: 'app.quit' },
  { keys: 'Mod+P', command: 'files.quickOpen' },
  { keys: 'Mod+Shift+P', command: 'app.palette', in: 'any' },
  { keys: 'Mod+B', command: 'app.toggleSidebar' },
  { keys: 'Mod+Shift+B', command: 'app.toggleSidebar', in: 'terminal' },
  { keys: 'Mod+0', command: 'app.focusList' },
  { keys: 'Mod+Shift+0', command: 'app.focusList', in: 'terminal' },
  { keys: 'Mod+1', command: 'core.focusEditor' },
  { keys: 'Mod+Shift+1', command: 'core.focusEditor', in: 'terminal' },
  { keys: 'Mod+Shift+E', command: 'files.show', in: 'any' },
  { keys: 'Mod+Shift+F', command: 'search.show', in: 'any' },
  { keys: 'Mod+Shift+T', command: 'terminals.show' },
  { keys: 'Mod+T', command: 'terminals.new' },
  // GNOME Terminal's new tab
  { keys: 'Mod+Shift+T', command: 'terminals.new', in: 'terminal' },
  { keys: 'Mod+2', command: 'terminals.focus' },
  // the commit box, the comment box, the repo switcher and the terminal handle these
  { keys: 'Mod+Enter', command: 'git.commit', local: true },
  { keys: 'Enter', command: 'search.run', local: true },
  { keys: 'Mod+Enter', command: 'comments.save', local: true },
  { keys: 'Mod+Shift+Enter', command: 'comments.send', local: true },
  { keys: 'Mod+Shift+C', command: 'terminals.copy', local: true },
  { keys: 'Mod+Shift+V', command: 'terminals.paste', local: true },
];
