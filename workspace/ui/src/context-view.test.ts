import { describe, expect, it } from 'vitest';
import { EditorView } from '@codemirror/view';
import type { EditorState } from '@codemirror/state';
import { foldedRanges, forceParsing } from '@codemirror/language';
import { buildState } from './editor';
import { foldToChanges, keepRanges } from './context-view';

const CLASS = `class Foo {
  alpha() {
    return 1;
  }

  beta() {
    const x = 2;
    return x;
  }
}
`;

const FLAT = 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\n';

const SIBLINGS = `function a() {
  return 1;
}

function b() {
  return 2;
}
`;

/**
 * keepRanges reads the syntax tree, and the app only ever reaches it through foldToChanges,
 * which forces the parse first. Left to itself CodeMirror parses one opening quantum of a few
 * thousand characters, so without this the assertions turn on how much of the document that
 * happened to cover: green on a fast machine, the bare fallback range on a loaded CI runner.
 */
async function state(path: string, doc: string, original: string): Promise<EditorState> {
  const view = new EditorView({ state: await buildState('unstaged', path, doc, original, () => {}) });
  forceParsing(view, view.state.doc.length, 5000);
  const parsed = view.state;
  view.destroy();
  return parsed;
}

describe('changes-only keep ranges', () => {
  it('keeps the enclosing method whole and only the header line of the class around it', async () => {
    const s = await state('x.ts', CLASS, CLASS.replace('return x;', 'return 9;'));
    expect(keepRanges(s)).toEqual([{ first: 1, last: 1 }, { first: 6, last: 9 }]);
  });

  it('falls back to three lines either side when nothing encloses the chunk', async () => {
    const s = await state('x.txt', FLAT, FLAT.replace('f\n', 'F\n'));
    expect(keepRanges(s)).toEqual([{ first: 3, last: 9 }]);
  });

  it('folds every gap between the kept ranges and labels it with its line count', async () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const view = new EditorView({ state: await state('x.ts', CLASS, CLASS.replace('return x;', 'return 9;')), parent });
    foldToChanges(view);
    const folded: string[] = [];
    foldedRanges(view.state).between(0, view.state.doc.length, (from, to) => {
      folded.push(`${view.state.doc.lineAt(from).number}-${view.state.doc.lineAt(to).number}`);
    });
    expect(folded).toEqual(['2-5', '10-11']);
    expect(view.dom.querySelector('.cm-foldPlaceholder')?.textContent).toBe('⋯ 4 lines');
  });

  it('merges across a one line gap rather than folding an empty or pointless range', async () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const doc = SIBLINGS.replace('return 1;', 'return 8;').replace('return 2;', 'return 9;');
    const view = new EditorView({ state: await state('x.ts', doc, SIBLINGS), parent });
    expect(keepRanges(view.state)).toEqual([{ first: 1, last: 7 }]);
    expect(() => foldToChanges(view)).not.toThrow();
    const folded: string[] = [];
    foldedRanges(view.state).between(0, view.state.doc.length, (from, to) => {
      folded.push(`${view.state.doc.lineAt(from).number}-${view.state.doc.lineAt(to).number}`);
    });
    expect(folded).toEqual([]);
  });
});

describe('changes-only keeps context, not the whole file', () => {
  it('does not treat a block the change opens as the context around it', async () => {
    const s = await state('x.ts', CLASS, CLASS.replace('class Foo {', 'class Bar {'));
    expect(keepRanges(s)).toEqual([{ first: 1, last: 4 }]);
  });

  it('gives an encloser longer than the cap its header line only', async () => {
    const body = Array.from({ length: 90 }, (_, i) => `  const n${i} = ${i};`);
    const big = `function big() {\n${body.join('\n')}\n}\n`;
    const s = await state('x.ts', big, big.replace('const n45 = 45;', 'const n45 = 99;'));
    expect(keepRanges(s)).toEqual([{ first: 1, last: 1 }, { first: 44, last: 50 }]);
  });
});
