export type Action =
  | 'nextHunk' | 'prevHunk' | 'accept' | 'reject' | 'unstage'
  | 'acceptFile' | 'rejectFile' | 'stageAll' | 'nextFile' | 'prevFile'
  | 'quickOpen' | 'palette' | 'save' | 'toggleSidebar'
  | 'focusList' | 'focusEditor' | 'focusCommit' | 'filesTab' | 'escape'
  | 'newTerminal' | 'terminalsTab' | 'focusTerminal';

/** Everything else belongs to the terminal when it has focus: Escape, F7, Cmd-K, Cmd-N, Cmd-S
 *  and Cmd-Y are all keys vim, top and the agent CLIs expect to receive themselves. */
const TERMINAL_SAFE = new Set<Action>([
  'newTerminal', 'terminalsTab', 'focusTerminal', 'palette', 'quickOpen',
  'toggleSidebar', 'filesTab', 'focusList', 'focusEditor',
]);

export function installKeys(dispatch: (a: Action) => void, onChord: (visible: boolean) => void = () => {}): void {
  let chordUntil = 0;

  document.addEventListener(
    'keydown',
    (e) => {
      const { code, metaKey: meta, altKey: alt, shiftKey: shift, ctrlKey: ctrl } = e;
      // the event target inside a terminal is xterm's hidden textarea, not the host element
      const inTerminal = e.target instanceof Element && !!e.target.closest('.term-host');
      const fire = (a: Action) => {
        if (inTerminal && !TERMINAL_SAFE.has(a)) return;
        e.preventDefault();
        e.stopPropagation();
        dispatch(a);
      };

      if (Date.now() < chordUntil && !inTerminal) {
        chordUntil = 0;
        onChord(false);
        if (meta && alt && code === 'KeyS') return fire('accept');
        if (meta && code === 'KeyR') return fire('reject');
        if (meta && code === 'KeyN') return fire('unstage');
        return;
      }
      if (e.key === 'F5' && alt) return fire(shift ? 'prevHunk' : 'nextHunk');
      if (e.key === 'F7') return fire(shift ? 'prevHunk' : 'nextHunk');
      if (e.key === 'Escape') { if (!inTerminal) dispatch('escape'); return; }
      if (ctrl && shift && code === 'KeyG') return fire('focusCommit');
      if (!meta || ctrl) return;
      if (code === 'KeyK' && !shift && !alt && !inTerminal) {
        chordUntil = Date.now() + 2500;
        onChord(true);
        setTimeout(() => { if (Date.now() >= chordUntil) onChord(false); }, 2600);
        e.preventDefault();
        return;
      }
      if (code === 'KeyY' && !(alt && shift)) return fire(alt ? 'stageAll' : shift ? 'acceptFile' : 'accept');
      if (code === 'KeyN' && !alt) return fire(shift ? 'rejectFile' : 'reject');
      if (shift && code === 'BracketRight') return fire('nextFile');
      if (shift && code === 'BracketLeft') return fire('prevFile');
      if (code === 'KeyP' && !alt) return fire(shift ? 'palette' : 'quickOpen');
      if (code === 'KeyS' && !shift && !alt) return fire('save');
      if (code === 'KeyB' && !shift && !alt) return fire('toggleSidebar');
      if (code === 'Digit0' && !shift && !alt) return fire('focusList');
      if (code === 'Digit1' && !shift && !alt) return fire('focusEditor');
      if (shift && code === 'KeyE') return fire('filesTab');
      if (shift && code === 'KeyT') return fire('terminalsTab');
      if (code === 'KeyT' && !shift && !alt) return fire('newTerminal');
      if (code === 'Digit2' && !shift && !alt) return fire('focusTerminal');
    },
    true,
  );
}
