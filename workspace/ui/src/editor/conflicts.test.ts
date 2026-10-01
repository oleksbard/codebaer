import { describe, expect, it } from 'vitest';
import { Text } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { buildState } from './editor';
import { conflictIndexAtCursor, conflictMarkers, conflicts, parseConflicts, resolveConflict } from './conflicts';

const doc = (s: string): Text => Text.of(s.split('\n'));

const TWO_WAY = 'top\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> origin/main\nbottom\n';
const DIFF3 = 'top\n<<<<<<< HEAD\nours\n||||||| base\nold\n=======\ntheirs\n>>>>>>> topic\nbottom\n';

async function mount(text: string) {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const state = await buildState('plain', 'x.txt', text, null, () => {}, [conflictMarkers]);
  return new EditorView({ state, parent });
}

describe('parseConflicts', () => {
  it('finds each conflict by its marker lines, with the diff3 base line when there is one', () => {
    expect(parseConflicts(doc(TWO_WAY))).toEqual([{ start: 2, base: null, mid: 4, end: 6, ambiguous: false }]);
    expect(parseConflicts(doc(DIFF3))).toEqual([{ start: 2, base: 4, mid: 6, end: 8, ambiguous: false }]);
    expect(parseConflicts(doc(`${TWO_WAY}${TWO_WAY}`))).toHaveLength(2);
  });

  it('skips a block with no end, a marker of another length and a separator with text after it', () => {
    expect(parseConflicts(doc('<<<<<<< a\nx\n=======\ny\n'))).toEqual([]);
    expect(parseConflicts(doc('<<<<<<<< a\nx\n=======\ny\n>>>>>>> b\n'))).toEqual([]);
    expect(parseConflicts(doc('<<<<<<< a\nx\n======= no\ny\n>>>>>>> b\n'))).toEqual([]);
  });

  it('starts again at a second start marker before the first block ends', () => {
    expect(parseConflicts(doc('<<<<<<< a\nstray\n<<<<<<< b\nx\n=======\ny\n>>>>>>> c\n')))
      .toEqual([{ start: 3, base: null, mid: 5, end: 7, ambiguous: false }]);
  });
});

describe('a side with a ======= line of its own', () => {
  const TEXT = 'top\n<<<<<<< HEAD\nTitle\n=======\nbody\n=======\ntheirs\n>>>>>>> b\n';

  it('is marked ambiguous, gets no keep buttons, and a keep does nothing', async () => {
    expect(parseConflicts(doc(TEXT))).toEqual([{ start: 2, base: null, mid: 4, end: 8, ambiguous: true }]);
    const view = await mount(TEXT);
    expect(view.contentDOM.querySelectorAll('.cm-conflictActions button')).toHaveLength(0);
    expect(view.contentDOM.querySelector('.cm-conflictTag')?.textContent).toBe('two ======= lines, edit by hand');
    resolveConflict(view, conflicts(view.state)[0]!, 'incoming');
    expect(view.state.doc.toString()).toBe(TEXT);
  });
});

describe('resolveConflict', () => {
  it.each([
    ['current', TWO_WAY, 'top\nours\nbottom\n'],
    ['incoming', TWO_WAY, 'top\ntheirs\nbottom\n'],
    ['both', TWO_WAY, 'top\nours\ntheirs\nbottom\n'],
    ['current', DIFF3, 'top\nours\nbottom\n'],
    ['incoming', DIFF3, 'top\ntheirs\nbottom\n'],
  ] as const)('keeps %s', async (keep, text, want) => {
    const view = await mount(text);
    resolveConflict(view, conflicts(view.state)[0]!, keep);
    expect(view.state.doc.toString()).toBe(want);
    expect(conflicts(view.state)).toEqual([]);
  });

  it('leaves no blank line for an empty side, and no line break the file did not end with', async () => {
    const empty = await mount('a\n<<<<<<< HEAD\n=======\nx\n>>>>>>> b\nz\n');
    resolveConflict(empty, conflicts(empty.state)[0]!, 'current');
    expect(empty.state.doc.toString()).toBe('a\nz\n');

    const last = await mount('a\n<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> b');
    resolveConflict(last, conflicts(last.state)[0]!, 'incoming');
    expect(last.state.doc.toString()).toBe('a\ny');
  });

  it('runs from the buttons on the start marker line, and the cursor lands where the conflict was', async () => {
    const view = await mount(`${TWO_WAY}${TWO_WAY}`);
    const buttons = view.contentDOM.querySelectorAll<HTMLButtonElement>('.cm-conflictActions button[name=incoming]');
    expect(buttons).toHaveLength(2);
    buttons[1]!.click();
    expect(view.state.doc.toString()).toBe(`${TWO_WAY}top\ntheirs\nbottom\n`);
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(9);
  });
});

describe('the marker decorations', () => {
  it('tint each side and label each marker line', async () => {
    const view = await mount(DIFF3);
    const cls = [...view.contentDOM.querySelectorAll('.cm-line')]
      .map((l) => l.className.replace(/\s*cm-activeLine/, ''));
    expect(cls.slice(1, 8)).toEqual([
      'cm-line cm-conflict cm-conflictCurrent cm-conflictHead',
      'cm-line cm-conflict cm-conflictCurrent',
      'cm-line cm-conflict cm-conflictBase cm-conflictHead',
      'cm-line cm-conflict cm-conflictBase',
      'cm-line cm-conflict cm-conflictSep',
      'cm-line cm-conflict cm-conflictIncoming',
      'cm-line cm-conflict cm-conflictIncoming cm-conflictHead',
    ]);
    const tags = [...view.contentDOM.querySelectorAll('.cm-conflictTag')].map((t) => t.textContent);
    expect(tags).toEqual(['current change', 'common ancestor', 'incoming change']);
  });

  it('follow edits: a conflict closed by typing gets its tint, and one counts where the cursor is', async () => {
    const view = await mount('<<<<<<< HEAD\nx\n=======\ny\n');
    expect(conflicts(view.state)).toEqual([]);
    view.dispatch({ changes: { from: view.state.doc.length, insert: '>>>>>>> b\n' } });
    expect(conflicts(view.state)).toHaveLength(1);
    view.dispatch({ selection: { anchor: view.state.doc.line(4).from } });
    expect(conflictIndexAtCursor(view.state)).toBe(0);
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    expect(conflictIndexAtCursor(view.state)).toBe(-1);
  });
});
