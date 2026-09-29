import { afterEach, describe, expect, it } from 'vitest';
import { EditorView } from '@codemirror/view';
import { foldEffect, foldedRanges, unfoldAll } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';
import { acceptChunk, buildState, getOriginalDoc, replaceOriginal } from './editor';
import { setEditorDark } from './editor-theme';
import { closePane, isSideBySide, originalPane, setSideBySide, sideBySide } from './side-by-side';

const ORIGINAL = 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n';
// line 2 changed, a line added after 5, line 9 removed
const DOC = 'a\nB\nc\nd\ne\nnew\nf\ng\nh\nj\n';

const views: EditorView[] = [];
afterEach(() => {
  for (const v of views.splice(0)) { closePane(v); v.destroy(); }
  document.body.textContent = '';
});

async function mount(show = true, doc = DOC, original = ORIGINAL): Promise<{ right: EditorView; left: EditorView }> {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const state = await buildState('unstaged', 'x.txt', doc, original, () => {}, [sideBySide(show)]);
  const right = new EditorView({ state, parent });
  views.push(right);
  const left = originalPane(right);
  parent.prepend(left.dom);
  return { right, left };
}

const folds = (s: EditorState): [number, number][] => {
  const out: [number, number][] = [];
  foldedRanges(s).between(0, s.doc.length, (f, t) => { out.push([s.doc.lineAt(f).number, s.doc.lineAt(t).number]); });
  return out;
};

describe('side by side', () => {
  it('shows the original on the left, read only, with the lines each chunk takes out marked', async () => {
    const { right, left } = await mount();
    expect(isSideBySide(right)).toBe(true);
    expect(left.state.doc.toString()).toBe(ORIGINAL);
    expect(left.state.readOnly).toBe(true);
    const marked = [...left.dom.querySelectorAll('.cm-changedLine')].map((l) => l.textContent);
    expect(marked).toEqual(['b', 'i']);
    expect(right.dom.classList.contains('cm-side')).toBe(true);
    expect(left.dom.classList.contains('cm-merge-a')).toBe(true);
  });

  it('follows the original through an accept and a re-read of the index', async () => {
    const { right, left } = await mount();
    right.dispatch({ selection: { anchor: right.state.doc.line(2).from } });
    acceptChunk(right);
    expect(left.state.doc.toString()).toBe(getOriginalDoc(right.state).toString());
    expect([...left.dom.querySelectorAll('.cm-changedLine')].map((l) => l.textContent)).toEqual(['i']);

    replaceOriginal(right, 'only\n');
    expect(left.state.doc.toString()).toBe('only\n');
  });

  it('turns on and off, and starts over from the current original when turned on again', async () => {
    const { right, left } = await mount(false);
    expect(isSideBySide(right)).toBe(false);
    setSideBySide(right, true);
    expect(isSideBySide(right)).toBe(true);
    expect(left.state.doc.toString()).toBe(ORIGINAL);

    setSideBySide(right, false);
    expect(right.dom.classList.contains('cm-side')).toBe(false);
    replaceOriginal(right, 'moved on\n');
    expect(left.state.doc.toString()).toBe(ORIGINAL);
    setSideBySide(right, true);
    expect(left.state.doc.toString()).toBe('moved on\n');
  });

  it('a pane asked for after the editor went side by side still fills', async () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const right = new EditorView({
      state: await buildState('unstaged', 'x.txt', DOC, ORIGINAL, () => {}, [sideBySide(true)]), parent,
    });
    views.push(right);
    expect(originalPane(right).state.doc.toString()).toBe(ORIGINAL);
  });

  it('mirrors folds both ways, mapped across the chunks', async () => {
    const { right, left } = await mount();
    // lines 7 to 9 on the right are f g h, lines 6 to 8 on the left
    right.dispatch({ effects: foldEffect.of({ from: right.state.doc.line(7).from, to: right.state.doc.line(9).to }) });
    expect(folds(left.state)).toEqual([[6, 8]]);

    unfoldAll(left);
    expect(folds(right.state)).toEqual([]);

    left.dispatch({ effects: foldEffect.of({ from: left.state.doc.line(3).from, to: left.state.doc.line(5).to }) });
    expect(folds(right.state)).toEqual([[3, 5]]);
  });

  it('passes a theme switch on to the left', async () => {
    const { right, left } = await mount();
    setEditorDark(right, true);
    expect(left.state.facet(EditorView.darkTheme)).toBe(true);
    setEditorDark(right, false);
    expect(left.state.facet(EditorView.darkTheme)).toBe(false);
  });
});
