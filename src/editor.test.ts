import { describe, expect, it } from 'vitest';
import { EditorView } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { acceptChunk, buildState, chunkCount, chunkIndexAtCursor, getOriginalDoc, rejectChunk, replaceDoc, replaceOriginal } from './editor';
import { editorHighlight } from './editor-theme';

const ORIGINAL = 'a\nb\nc\nd\n';
const DOC = 'A\nb\nc\nD\n';

async function mount(kind: 'unstaged' | 'staged', doc = DOC, original = ORIGINAL) {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const state = await buildState(kind, 'x.txt', doc, original, () => {});
  return new EditorView({ state, parent });
}

describe('CodeMirror merge contract', () => {
  it('acceptChunk at the cursor moves that chunk into the original', async () => {
    const view = await mount('unstaged');
    expect(chunkCount(view.state)).toBe(2);
    view.dispatch({ selection: { anchor: 0 } });
    expect(chunkIndexAtCursor(view.state)).toBe(0);
    expect(acceptChunk(view)).toBe(true);
    expect(getOriginalDoc(view.state).toString()).toBe('A\nb\nc\nd\n');
    expect(view.state.doc.toString()).toBe(DOC);
    expect(chunkCount(view.state)).toBe(1);
  });

  it('rejectChunk works with editable false and reverts the doc', async () => {
    const view = await mount('staged');
    view.dispatch({ selection: { anchor: view.state.doc.length - 2 } });
    expect(rejectChunk(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('A\nb\nc\nd\n');
  });

  it('replaceDoc stays out of history and replaceOriginal recomputes chunks', async () => {
    const view = await mount('unstaged');
    replaceDoc(view, ORIGINAL);
    expect(chunkCount(view.state)).toBe(0);
    replaceOriginal(view, 'zzz\n');
    expect(getOriginalDoc(view.state).toString()).toBe('zzz\n');
    expect(chunkCount(view.state)).toBe(1);
  });

  it('onDocChange fires for a real edit but not for a replaceDoc refresh', async () => {
    let count = 0;
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const state = await buildState('unstaged', 'x.txt', DOC, ORIGINAL, () => { count++; });
    const view = new EditorView({ state, parent });
    view.dispatch({ changes: { from: 0, insert: 'x' } });
    expect(count).toBe(1);
    replaceDoc(view, 'y\n');
    expect(count).toBe(1);
  });

  it('the state carries the token theme: dark flag set, keyword and comment get distinct classes', async () => {
    const view = await mount('unstaged');
    expect(view.state.facet(EditorView.darkTheme)).toBe(true);
    const keyword = editorHighlight.style([tags.keyword]);
    expect(keyword).toBeTruthy();
    expect(editorHighlight.style([tags.comment])).not.toBe(keyword);
  });

  it('the merge chunk rules name the merge root, so they outrank @codemirror/merge own base theme', async () => {
    await mount('unstaged');
    const css = [...document.querySelectorAll('style')].map((s) => s.textContent ?? '').join('\n');
    expect(css).toMatch(/\.cm-merge-b \.cm-changedText[^{]*\{[^}]*background: none/);
    expect(css).toMatch(/\.cm-merge-b \.cm-changedLine\s*\{[^}]*var\(--add-bg\)/);
    expect(css).toMatch(/\.cm-merge-b \.cm-changedLineGutter\s*\{[^}]*var\(--add\)/);
  });
});
