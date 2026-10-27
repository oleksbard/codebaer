import { describe, expect, it } from 'vitest';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { matchStarts, selectionMatches } from './match-marks';

const state = (doc: string, selection: EditorSelection) => EditorState.create({ doc, selection });

describe('matchStarts', () => {
  it('finds every match of the selection, its own included', () => {
    expect(matchStarts(state('foo bar foo\nfoobar', EditorSelection.single(0, 3)))).toEqual([0, 8, 12]);
  });

  it('finds nothing for a cursor, a lone match, several ranges or a selection over 200 characters', () => {
    expect(matchStarts(state('foo foo', EditorSelection.single(1)))).toEqual([]);
    expect(matchStarts(state('foo bar', EditorSelection.single(0, 3)))).toEqual([]);
    expect(matchStarts(EditorState.create({
      doc: 'foo foo',
      selection: EditorSelection.create([EditorSelection.range(0, 1), EditorSelection.range(4, 5)]),
      extensions: EditorState.allowMultipleSelections.of(true),
    }))).toEqual([]);
    const long = 'x'.repeat(201);
    expect(matchStarts(state(`${long} ${long}`, EditorSelection.single(0, 201)))).toEqual([]);
  });
});

describe('selectionMatches', () => {
  it('adds the scrollbar strip to the editor and removes it with the plugin', () => {
    const view = new EditorView({
      state: EditorState.create({ doc: 'a a', extensions: selectionMatches }),
      parent: document.body,
    });
    expect(view.dom.querySelector('.cm-matchMarks')).not.toBeNull();
    view.setState(EditorState.create({ doc: 'a a' }));
    expect(view.dom.querySelector('.cm-matchMarks')).toBeNull();
    view.destroy();
  });
});
