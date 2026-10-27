import { describe, expect, it } from 'vitest';
import { EditorState, Text } from '@codemirror/state';
import { lineNumberMarkers, type GutterMarker } from '@codemirror/view';
import { lineMarks, setBase } from './branch-lines';

function marks(state: EditorState): Record<number, string> {
  const out: Record<number, string> = {};
  for (const set of state.facet(lineNumberMarkers)) {
    set.between(0, state.doc.length, (from, _to, m: GutterMarker) => {
      out[state.doc.lineAt(from).number] = m.elementClass.replace('cm-branchLine cm-branch', '');
    });
  }
  return out;
}

const withBase = (base: string, doc: string) => {
  const s = EditorState.create({ doc, extensions: lineMarks });
  return s.update({ effects: setBase.of(Text.of(base.split('\n'))) }).state;
};

describe('lineMarks', () => {
  it('marks added and modified lines, and the line below a deletion', () => {
    const base = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
    const doc = ['a', 'B', 'c', 'd', 'e', 'new', 'f', 'g', 'h', 'j'];
    expect(marks(withBase(base.join('\n'), doc.join('\n')))).toEqual({ 2: 'Modified', 6: 'Added', 10: 'Deleted' });
  });

  it('follows an edit, and clears with a null base', () => {
    const s = withBase('a\nb', 'a\nb');
    expect(marks(s)).toEqual({});
    const edited = s.update({ changes: { from: 0, insert: 'x\n' } }).state;
    expect(marks(edited)).toEqual({ 1: 'Added' });
    expect(marks(edited.update({ effects: setBase.of(null) }).state)).toEqual({});
  });
});
