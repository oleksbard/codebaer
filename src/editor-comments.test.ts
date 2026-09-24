import { describe, expect, it, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView, showTooltip } from '@codemirror/view';
import { buildState, rejectChunk, replaceDoc, type ViewKind } from './editor';
import { commentHost, commentSpan, lineRange, marksOf, onComments, setMarks } from './editor-comments';

async function mount(kind: ViewKind, doc: string, original: string | null = null) {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const state = await buildState(kind, 'src/x.ts', doc, original, () => {});
  return new EditorView({ state, parent });
}

const lines = (view: EditorView) => marksOf(view.state).map((m) => ({
  key: m.key, from: view.state.doc.lineAt(m.from).number, to: view.state.doc.lineAt(m.to).number,
}));

describe('lineRange', () => {
  it('widens to whole lines, and a selection ending at column 0 stops on the line before', () => {
    const doc = EditorState.create({ doc: 'aa\nbb\ncc\n' }).doc;
    expect(lineRange(doc, 1, 1)).toEqual({ from: 1, to: 1 });
    expect(lineRange(doc, 1, 4)).toEqual({ from: 1, to: 2 });
    expect(lineRange(doc, 0, 6)).toEqual({ from: 1, to: 2 });
  });
});

describe('commentSpan', () => {
  it('quotes plain code, with the language from the extension, outside any hunk', async () => {
    const view = await mount('plain', 'one\ntwo\nthree\n');
    expect(commentSpan(view.state, 'src/x.ts', 2, 2)).toEqual({
      from: 2, to: 2, anchor: 'two', quote: { t: 'code', lang: 'ts', text: 'two' },
    });
  });

  it('quotes the selected lines of a touched hunk as a diff, removed lines first, without widening', async () => {
    const view = await mount('unstaged', 'A\nB\nc\nd\n', 'a\nb\nc\nd\n');
    const span = commentSpan(view.state, 'src/x.ts', 2, 3);
    expect(span.from).toBe(2);
    expect(span.to).toBe(3);
    expect(span.anchor).toBe('B\nc');
    expect(span.quote).toEqual({ t: 'diff', text: '-a\n-b\n+B\n c' });
  });

  it('keeps the selected line in the quote of a comment inside one big hunk, such as a new file', async () => {
    const doc = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n');
    const view = await mount('unstaged', `${doc}\n`, 'old 1\nold 2\n'.repeat(10));
    const span = commentSpan(view.state, 'src/x.ts', 60, 60);
    expect([span.from, span.to]).toEqual([60, 60]);
    expect(span.quote.text.split('\n')).toEqual([
      ...Array.from({ length: 10 }, (_, i) => `-old ${(i % 2) + 1}`),
      '(10 more removed lines not shown)',
      '+line 60',
    ]);
  });

  it('includes lines removed right above the commented line', async () => {
    const view = await mount('unstaged', 'a\nc\n', 'a\nb\nc\n');
    expect(commentSpan(view.state, 'src/x.ts', 2, 2).quote).toEqual({ t: 'diff', text: '-b\n c' });
    expect(commentSpan(view.state, 'src/x.ts', 1, 1).quote.t).toBe('code');
  });
});

describe('marks', () => {
  it('follow an edit above them', async () => {
    const view = await mount('plain', 'a\nb\nc\n');
    view.dispatch({ effects: setMarks.of([{ key: 'c:1', fromLine: 2, toLine: 3 }]) });
    view.dispatch({ changes: { from: 0, insert: 'new\n' } });
    expect(lines(view)).toEqual([{ key: 'c:1', from: 3, to: 4 }]);
  });

  it('do not grow onto the next line for Enter at their end, a deleted last line, or a rejected hunk', async () => {
    const view = await mount('plain', 'a\nb\nc\nd\n');
    view.dispatch({ effects: setMarks.of([{ key: 'c:1', fromLine: 2, toLine: 3 }]) });
    view.dispatch({ changes: { from: view.state.doc.line(3).to, insert: '\n' } });
    expect(lines(view)).toEqual([{ key: 'c:1', from: 2, to: 3 }]);
    view.dispatch({ changes: { from: view.state.doc.line(3).from, to: view.state.doc.line(4).from } });
    expect(lines(view)).toEqual([{ key: 'c:1', from: 2, to: 2 }]);

    const diff = await mount('unstaged', 'a\nB\nc\n', 'a\nb\nc\n');
    diff.dispatch({ effects: setMarks.of([{ key: 'c:2', fromLine: 2, toLine: 2 }]), selection: { anchor: 2 } });
    expect(rejectChunk(diff)).toBe(true);
    expect(diff.state.doc.toString()).toBe('a\nb\nc\n');
    expect(lines(diff)).toEqual([{ key: 'c:2', from: 2, to: 2 }]);
  });

  it('do not take in lines added at their start, and keep their size when a covered hunk is rejected', async () => {
    const view = await mount('plain', 'a\nb\nc\nd\n');
    view.dispatch({ effects: setMarks.of([{ key: 'c:1', fromLine: 2, toLine: 3 }]) });
    view.dispatch({ changes: { from: view.state.doc.line(2).from, insert: 'new\nlines\n' } });
    expect(lines(view)).toEqual([{ key: 'c:1', from: 4, to: 5 }]);

    const removal = await mount('unstaged', 'a\nc\n', 'a\nb\nc\n');
    removal.dispatch({ effects: setMarks.of([{ key: 'c:2', fromLine: 2, toLine: 2 }]), selection: { anchor: 2 } });
    expect(rejectChunk(removal)).toBe(true);
    expect(lines(removal)).toEqual([{ key: 'c:2', from: 3, to: 3 }]);

    const block = await mount('unstaged', 'a\nB\nC\nD\ne\n', 'a\nb\nc\nd\ne\n');
    block.dispatch({ effects: setMarks.of([{ key: 'c:3', fromLine: 2, toLine: 4 }]), selection: { anchor: 2 } });
    expect(rejectChunk(block)).toBe(true);
    expect(lines(block)).toEqual([{ key: 'c:3', from: 2, to: 4 }]);
  });

  it('drop a comment whose lines are all deleted, and keep the draft there marked lost', async () => {
    const view = await mount('plain', 'a\nb\nc\nd\n');
    view.dispatch({ effects: setMarks.of([
      { key: 'c:1', fromLine: 2, toLine: 3 }, { key: 'draft', fromLine: 2, toLine: 3 },
    ]) });
    view.dispatch({ changes: { from: view.state.doc.line(2).from, to: view.state.doc.line(4).from } });
    expect(marksOf(view.state)).toEqual([{ key: 'draft', from: 2, to: 3, lost: true }]);
    replaceDoc(view, 'a\nd\n');
    expect(marksOf(view.state)[0]?.lost).toBe(true);
  });

  it('re-anchor through a whole-document refresh, drop a comment whose lines are gone, keep the draft', async () => {
    const view = await mount('plain', 'a\nkeep\nlose\nb\n');
    view.dispatch({ effects: setMarks.of([
      { key: 'c:1', fromLine: 2, toLine: 2 }, { key: 'c:2', fromLine: 3, toLine: 3 },
      { key: 'draft', fromLine: 3, toLine: 3 },
    ]) });
    replaceDoc(view, 'top\na\nb\nkeep\n');
    expect(lines(view)).toEqual([{ key: 'c:1', from: 4, to: 4 }, { key: 'draft', from: 3, to: 3 }]);
  });

  it('give each mark a host for React to portal into, and tell the controller about edits', async () => {
    const run = vi.fn();
    onComments.run = run;
    const view = await mount('plain', 'a\nb\n');
    view.dispatch({ changes: { from: 0, insert: 'x' } });
    expect(run).not.toHaveBeenCalled();
    view.dispatch({ effects: setMarks.of([{ key: 'c:7', fromLine: 1, toLine: 1 }]) });
    await Promise.resolve();
    expect(commentHost('c:7')?.isConnected).toBe(true);
    view.dispatch({ changes: { from: 0, insert: 'y' } });
    expect(run).toHaveBeenCalledOnce();
    onComments.run = () => {};
  });
});

describe('the Comment chip', () => {
  const chip = (view: EditorView) => view.state.facet(showTooltip).filter(Boolean).length;

  it('shows for a non-empty selection while no draft is open', async () => {
    const view = await mount('staged', 'abc\ndef\n', 'abc\n');
    expect(chip(view)).toBe(0);
    view.dispatch({ selection: { anchor: 0, head: 2 } });
    expect(chip(view)).toBe(1);
    view.dispatch({ effects: setMarks.of([{ key: 'draft', fromLine: 1, toLine: 1 }]) });
    expect(chip(view)).toBe(0);
  });
});
