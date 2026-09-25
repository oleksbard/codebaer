import { describe, expect, it, vi } from 'vitest';
import { ChangeSet, EditorState } from '@codemirror/state';
import { EditorView, showTooltip } from '@codemirror/view';
import {
  copyLineDown, deleteCharBackward, deleteCharForward, deleteLine, indentLess, indentMore, insertNewlineAndIndent,
  moveLineDown, moveLineUp, undo,
} from '@codemirror/commands';
import { buildState, rejectChunk, replaceDoc, type ViewKind } from './editor';
import {
  commentHost, commentSpan, lineRange, marksOf, onComments, PosMapper, setMarks, type Edit,
} from './editor-comments';

async function mount(kind: ViewKind, doc: string, original: string | null = null) {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const state = await buildState(kind, 'src/x.ts', doc, original, () => {});
  return new EditorView({ state, parent });
}

const lines = (view: EditorView) => marksOf(view.state).map((m) => ({
  key: m.key, from: view.state.doc.lineAt(m.from).number, to: view.state.doc.lineAt(m.to).number,
}));

describe('PosMapper', () => {
  it('maps non-decreasing positions exactly as ChangeSet.mapPos does', () => {
    let seed = 7;
    const rand = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    for (let round = 0; round < 400; round++) {
      const len = rand(40);
      const specs: { from: number; to: number; insert: string }[] = [];
      for (let at = 0; at <= len;) {
        at += rand(6);
        if (at > len) break;
        const to = Math.min(len, at + rand(4));
        specs.push({ from: at, to, insert: ['', 'x', 'yz\n', '\n'][rand(4)]! });
        at = to + 1;
      }
      const set = ChangeSet.of(specs, len);
      const edits: Edit[] = [];
      set.iterChanges((fromA, toA, fromB, toB) => { edits.push({ fromA, toA, fromB, toB }); });
      const map = new PosMapper(edits);
      for (let pos = 0; pos <= len; pos += 1 + rand(2)) {
        for (const assoc of rand(2) ? [-1, 1] as const : [1, -1] as const) {
          expect([round, pos, assoc, map.map(pos, assoc)]).toEqual([round, pos, assoc, set.mapPos(pos, assoc)]);
        }
      }
    }
  });
});

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

  it('stay on their own lines when Enter adds an indented line at the start or the end', async () => {
    const enterAt = async (pos: (v: EditorView) => number) => {
      const view = await mount('plain', 'function f() {\n  a();\n  b();\n}\n');
      view.dispatch({
        effects: setMarks.of([{ key: 'c:1', fromLine: 2, toLine: 3 }]), selection: { anchor: pos(view) },
      });
      insertNewlineAndIndent(view);
      return { doc: view.state.doc, marks: lines(view) };
    };
    const col0 = await enterAt((v) => v.state.doc.line(2).from);
    expect(col0.marks).toEqual([{ key: 'c:1', from: 3, to: 4 }]);
    expect(col0.doc.line(3).text).toBe('  a();');
    expect((await enterAt((v) => v.state.doc.line(2).from + 2)).marks).toEqual([{ key: 'c:1', from: 3, to: 4 }]);
    expect((await enterAt((v) => v.state.doc.line(3).to)).marks).toEqual([{ key: 'c:1', from: 2, to: 3 }]);
  });

  it('stay on an indented hunk that is rejected, and take in what is pasted over their first line', async () => {
    const reject = async (fromLine: number, toLine: number) => {
      const view = await mount('unstaged', 'a\n  B\n  C\n  D\ne\n', 'a\n  b\n  c\n  d\ne\n');
      view.dispatch({ effects: setMarks.of([{ key: 'c:1', fromLine, toLine }]), selection: { anchor: 2 } });
      expect(rejectChunk(view)).toBe(true);
      return lines(view);
    };
    expect(await reject(2, 4)).toEqual([{ key: 'c:1', from: 2, to: 4 }]);
    expect(await reject(2, 2)).toEqual([{ key: 'c:1', from: 2, to: 2 }]);

    const view = await mount('plain', 'a\n  x\n  y\nz\n');
    view.dispatch({ effects: setMarks.of([{ key: 'c:2', fromLine: 2, toLine: 3 }]) });
    view.dispatch({ changes: { from: view.state.doc.line(2).from, to: view.state.doc.line(2).to, insert: 'p1\np2' } });
    expect(lines(view)).toEqual([{ key: 'c:2', from: 2, to: 4 }]);
  });

  it('keep a blank-line comment when the line above goes, and a blank last line when text is typed elsewhere',
    async () => {
      const view = await mount('plain', 'a\nb\n\nd\n');
      view.dispatch({ effects: setMarks.of([{ key: 'c:1', fromLine: 3, toLine: 3 }]) });
      view.dispatch({ changes: { from: view.state.doc.line(2).from, to: view.state.doc.line(3).from } });
      expect(lines(view)).toEqual([{ key: 'c:1', from: 2, to: 2 }]);

      const added = await mount('unstaged', 'a\nnew\n\nd\n', 'a\n\nd\n');
      added.dispatch({ effects: setMarks.of([{ key: 'c:2', fromLine: 3, toLine: 3 }]), selection: { anchor: 2 } });
      expect(rejectChunk(added)).toBe(true);
      expect(lines(added)).toEqual([{ key: 'c:2', from: 2, to: 2 }]);

      const tail = await mount('plain', 'a\nb\n\nd\n');
      tail.dispatch({ effects: setMarks.of([{ key: 'c:3', fromLine: 2, toLine: 3 }]) });
      tail.dispatch({ changes: { from: tail.state.doc.length, insert: 'more' } });
      expect(lines(tail)).toEqual([{ key: 'c:3', from: 2, to: 3 }]);
    });

  it('do not grow when Enter is pressed on a whitespace-only commented line', async () => {
    const view = await mount('plain', 'a\n    \nc\n');
    view.dispatch({ effects: setMarks.of([{ key: 'c:1', fromLine: 2, toLine: 2 }]), selection: { anchor: 4 } });
    insertNewlineAndIndent(view);
    const [m] = lines(view);
    expect(m!.from).toBe(m!.to);
    expect(view.state.doc.line(4).text).toBe('c');
    expect(m!.from).toBeLessThan(4);
  });

  const at = async (doc: string, marks: [string, number, number][], cursorLine: number) => {
    const view = await mount('plain', doc);
    view.dispatch({
      effects: setMarks.of(marks.map(([key, fromLine, toLine]) => ({ key, fromLine, toLine }))),
      selection: { anchor: view.state.doc.line(cursorLine).from },
    });
    return view;
  };
  const text = (view: EditorView) => marksOf(view.state).map((m) => [m.key, view.state.sliceDoc(m.from, m.to)]);

  it('go when their line is deleted with Shift-Cmd-K, and take nothing extra in on undo', async () => {
    const one = await at('a\nb\nc\nd\n', [['c:1', 2, 2]], 2);
    deleteLine(one);
    expect(text(one)).toEqual([]);

    const two = await at('a\nb\nc\nd\n', [['c:1', 2, 3]], 2);
    deleteLine(two);
    expect(text(two)).toEqual([['c:1', 'c']]);
    undo(two);
    expect(two.state.doc.toString()).toBe('a\nb\nc\nd\n');
    expect(text(two)).toEqual([['c:1', 'c']]);

    const draft = await at('a\nb\nc\n', [['draft', 2, 2]], 2);
    deleteLine(draft);
    expect(marksOf(draft.state)[0]?.lost).toBe(true);

    const blank = await at('a\n\nc\n', [['c:1', 2, 2]], 2);
    deleteCharBackward(blank);
    expect(text(blank)).toEqual([]);
  });

  it('follow their lines when lines are moved with Alt-Up and Alt-Down', async () => {
    const down = await at('a\nb\nc\nd\n', [['c:1', 3, 3], ['c:2', 2, 2]], 2);
    moveLineDown(down);
    expect(down.state.doc.toString()).toBe('a\nc\nb\nd\n');
    expect(text(down)).toEqual([['c:1', 'c'], ['c:2', 'b']]);

    const up = await at('a\nb\nc\nd\n', [['c:1', 2, 2]], 3);
    moveLineUp(up);
    expect(text(up)).toEqual([['c:1', 'b']]);
  });

  it('stay on their own lines through an edit that changes every line in place', async () => {
    const view = await at('if (a) {\n    return null;\n  }\n  return null;\n', [['c:1', 2, 2], ['c:2', 4, 4]], 2);
    view.dispatch({ selection: { anchor: view.state.doc.line(2).from, head: view.state.doc.line(4).to } });
    indentMore(view);
    expect(text(view)).toEqual([['c:1', '      return null;'], ['c:2', '    return null;']]);
    indentLess(view);
    expect(text(view)).toEqual([['c:1', '    return null;'], ['c:2', '  return null;']]);

    const toggled = await at('  x = 1;\n  // x = 1;\n', [['c:1', 1, 1], ['c:2', 2, 2]], 1);
    toggled.dispatch({ changes: [
      { from: 2, insert: '// ' }, { from: toggled.state.doc.line(2).from + 2, to: toggled.state.doc.line(2).from + 5 },
    ] });
    expect(text(toggled)).toEqual([['c:1', '  // x = 1;'], ['c:2', '  x = 1;']]);
  });

  it('keep lines that stay when whole lines before them are deleted, pasted or copied', async () => {
    const json = await at('[\n  {\n    "id": 1\n  },\n  {\n    "id": 2\n  }\n]\n', [['c:1', 5, 7]], 1);
    json.dispatch({ changes: { from: json.state.doc.line(2).from, to: json.state.doc.line(5).from } });
    expect(text(json)).toEqual([['c:1', '  {\n    "id": 2\n  }']]);

    const pasted = await at('a\n}\nx\n', [['c:1', 2, 3]], 1);
    pasted.dispatch({ changes: { from: pasted.state.doc.line(2).from, insert: '}\nfoo\n' } });
    expect(text(pasted)).toEqual([['c:1', '}\nx']]);

    const copied = await at('a\nb\nc\n', [['c:1', 2, 2]], 2);
    copyLineDown(copied);
    expect(text(copied)).toEqual([['c:1', 'b']]);
  });

  it('follow a line joined onto the one above, and cover both halves of a line split by Enter', async () => {
    const back = await at('foo(\n  bar)\n', [['c:1', 2, 2]], 2);
    deleteCharBackward(back);
    expect(text(back)).toEqual([['c:1', 'foo(  bar)']]);

    const forward = await at('foo(\n  bar)\n', [['c:1', 2, 2]], 1);
    forward.dispatch({ selection: { anchor: forward.state.doc.line(1).to } });
    deleteCharForward(forward);
    expect(text(forward)).toEqual([['c:1', 'foo(  bar)']]);

    const split = await at('one two\n', [['c:1', 1, 1]], 1);
    split.dispatch({ selection: { anchor: 3 } });
    insertNewlineAndIndent(split);
    expect(split.state.doc.lines).toBe(3);
    expect(lines(split)).toEqual([{ key: 'c:1', from: 1, to: 2 }]);
  });

  it('keep a line moved within them', async () => {
    const within = await at('a\nb\nc\nd\n', [['c:1', 2, 3]], 2);
    moveLineDown(within);
    expect(text(within)).toEqual([['c:1', 'c\nb']]);
  });

  it('go when the added last line they are on is rejected, in a file without a final newline', async () => {
    const view = await mount('unstaged', 'a\nb\nc', 'a\nb');
    view.dispatch({ effects: setMarks.of([{ key: 'c:1', fromLine: 3, toLine: 3 }]), selection: { anchor: 4 } });
    expect(rejectChunk(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('a\nb');
    expect(text(view)).toEqual([]);
  });

  it('keep a blank-line comment when the line below it is deleted', async () => {
    const blank = await at('a\n\nc\nd\n', [['c:1', 2, 2]], 3);
    deleteLine(blank);
    expect(blank.state.doc.toString()).toBe('a\n\nd\n');
    expect(lines(blank)).toEqual([{ key: 'c:1', from: 2, to: 2 }]);

    const spaces = await at('a\n   \nc\nd\n', [['c:1', 2, 2]], 3);
    deleteLine(spaces);
    expect(text(spaces)).toEqual([['c:1', '   ']]);

    const last = await at('a\n\nz', [['c:1', 2, 2]], 3);
    deleteLine(last);
    expect(lines(last)).toEqual([{ key: 'c:1', from: 2, to: 2 }]);
  });

  it('keep a comment whose line text is cleared, and drop one on a blank line that is deleted', async () => {
    const view = await mount('plain', 'a\nb\n\nd\n');
    view.dispatch({
      effects: setMarks.of([{ key: 'c:1', fromLine: 2, toLine: 2 }, { key: 'c:2', fromLine: 3, toLine: 3 }]),
    });
    view.dispatch({ changes: { from: view.state.doc.line(2).from, to: view.state.doc.line(2).to } });
    expect(lines(view)).toEqual([{ key: 'c:1', from: 2, to: 2 }, { key: 'c:2', from: 3, to: 3 }]);
    view.dispatch({ changes: { from: view.state.doc.line(3).from, to: view.state.doc.line(4).from } });
    expect(lines(view)).toEqual([{ key: 'c:1', from: 2, to: 2 }]);
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
