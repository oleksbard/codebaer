export type Action =
  | 'nextHunk' | 'prevHunk' | 'accept' | 'reject' | 'unstage'
  | 'acceptFile' | 'rejectFile' | 'stageAll' | 'nextFile' | 'prevFile'
  | 'quickOpen' | 'palette' | 'save' | 'toggleSidebar'
  | 'focusList' | 'focusEditor' | 'focusCommit' | 'filesTab' | 'escape';

export function installKeys(dispatch: (a: Action) => void): void {
  let chordUntil = 0;
  const hint = document.createElement('div');
  hint.className = 'chord';
  hint.hidden = true;
  hint.textContent = '⌘K, then ⌘⌥S stage · ⌘R revert · ⌘N unstage';
  document.body.appendChild(hint);

  document.addEventListener(
    'keydown',
    (e) => {
      const { code, metaKey: meta, altKey: alt, shiftKey: shift, ctrlKey: ctrl } = e;
      const fire = (a: Action) => { e.preventDefault(); e.stopPropagation(); dispatch(a); };

      if (Date.now() < chordUntil) {
        chordUntil = 0;
        hint.hidden = true;
        if (meta && alt && code === 'KeyS') return fire('accept');
        if (meta && code === 'KeyR') return fire('reject');
        if (meta && code === 'KeyN') return fire('unstage');
        return;
      }
      if (e.key === 'F5' && alt) return fire(shift ? 'prevHunk' : 'nextHunk');
      if (e.key === 'F7') return fire(shift ? 'prevHunk' : 'nextHunk');
      if (e.key === 'Escape') { dispatch('escape'); return; }
      if (ctrl && shift && code === 'KeyG') return fire('focusCommit');
      if (!meta || ctrl) return;
      if (code === 'KeyK' && !shift && !alt) {
        chordUntil = Date.now() + 2500;
        hint.hidden = false;
        setTimeout(() => { if (Date.now() >= chordUntil) hint.hidden = true; }, 2600);
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
    },
    true,
  );
}
