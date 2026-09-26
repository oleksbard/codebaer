import { Compartment, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { HighlightStyle } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

/** Colours come from the tokens, so a theme switch repaints them for free; this flag is what picks
 *  the light or dark half of CodeMirror's own base styles (search panel, merge, tooltips). */
const darkMode = new Compartment();

export const editorDark = (dark: boolean): Extension => darkMode.of(EditorView.darkTheme.of(dark));

export function setEditorDark(view: EditorView, dark: boolean): void {
  view.dispatch({ effects: darkMode.reconfigure(EditorView.darkTheme.of(dark)) });
}

const ACCEPT = 'color-mix(in srgb, var(--add) 50%, var(--text))';
const REJECT = 'color-mix(in srgb, var(--del) 50%, var(--text))';

export const editorTheme = EditorView.theme(
  {
    '&': { color: 'var(--text)', backgroundColor: 'var(--bg)' },
    '.cm-content': { caretColor: 'var(--text)' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--text)' },
    ['&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground,'
      + ' .cm-selectionBackground, .cm-content ::selection']: {
      backgroundColor: 'var(--accent-soft)',
    },
    '.cm-selectionMatch': { backgroundColor: 'var(--sel)' },
    '.cm-activeLine': { backgroundColor: 'var(--panel)' },
    '.cm-gutters': { backgroundColor: 'var(--bg)', color: 'var(--faint)', borderRight: '1px solid var(--line)' },
    '.cm-activeLineGutter': { backgroundColor: 'var(--panel)' },
    '.cm-panels': { backgroundColor: 'var(--panel)', color: 'var(--text)' },
    '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--line)' },
    '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--line)' },
    '.cm-searchMatch': { backgroundColor: 'var(--accent-soft)', outline: '1px solid var(--accent)' },
    '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--sel)' },
    '.cm-tooltip': { backgroundColor: 'var(--panel)', border: '1px solid var(--line)' },
    '.cm-deletedChunk': { backgroundColor: 'var(--del-bg)' },
    '.cm-insertedLine': { backgroundColor: 'var(--add-bg)' },
    '&.cm-merge-b .cm-changedLine': { backgroundColor: 'var(--add-bg)' },
    // the line tint already marks the change; @codemirror/merge's own word-level fill on top of it
    // reads as a second highlight per token, so both word rules are cleared rather than recoloured
    '&.cm-merge-b .cm-changedText, &.cm-merge-a .cm-changedText': { background: 'none' },
    '.cm-deletedChunk .cm-deletedText, &.cm-merge-b .cm-deletedText': { background: 'none' },
    '&.cm-merge-b .cm-changedLineGutter': { background: 'var(--add)' },
    '.cm-deletedLineGutter': { background: 'var(--del)' },
    // floated rather than @codemirror/merge's absolute position: lines wrap, so the deleted text flows
    // around the buttons instead of under them. The merge root outranks the library's base theme rule of the
    // same shape. A chunk that deletes nothing keeps the overlay: a row of its own would get the gutter's
    // deleted-line mark, which no selector can take off it.
    '&.cm-merge-b .cm-deletedChunk': { display: 'flow-root' },
    '&.cm-merge-b .cm-deletedChunk .cm-chunkButtons': {
      position: 'static', float: 'right', display: 'flex', margin: '1px 5px 1px 12px',
    },
    '&.cm-merge-b .cm-deletedChunk:not(:has(.cm-deletedLine)) .cm-chunkButtons': {
      position: 'absolute', float: 'none', margin: '0',
    },
    // [name] outranks the library's saturated [name=accept]/[name=reject] fills; quieter than the toolbar's
    // Accept, since these repeat on every hunk. One joined pair, so no code shows between the two.
    '.cm-deletedChunk .cm-chunkButtons button[name]': {
      position: 'relative',
      margin: '0',
      padding: '0 8px',
      border: '1px solid var(--line)',
      background: 'var(--panel)',
      font: '500 var(--fs-1)/1.6 var(--ui)',
    },
    // --add and --del are drawn as fills, and as 11px text several light themes' fall near 2:1, so the label
    // is half way to --text; the hover fill swaps the same two colours, which keeps the contrast
    '.cm-deletedChunk .cm-chunkButtons button[name=accept]': {
      color: ACCEPT, borderRadius: 'var(--r-2) 0 0 var(--r-2)',
    },
    '.cm-deletedChunk .cm-chunkButtons button[name=reject]': {
      color: REJECT, borderRadius: '0 var(--r-2) var(--r-2) 0', marginLeft: '-1px',
    },
    '.cm-deletedChunk .cm-chunkButtons button[name=accept]:hover': {
      zIndex: '1', background: ACCEPT, borderColor: ACCEPT, color: 'var(--panel)',
    },
    '.cm-deletedChunk .cm-chunkButtons button[name=reject]:hover': {
      zIndex: '1', background: REJECT, borderColor: REJECT, color: 'var(--panel)',
    },
  },
);

export const editorHighlight = HighlightStyle.define([
  { tag: t.keyword, color: 'var(--syn-keyword)' },
  { tag: [t.name, t.deleted, t.character, t.propertyName, t.macroName], color: 'var(--syn-name)' },
  { tag: [t.function(t.variableName), t.labelName], color: 'var(--syn-function)' },
  {
    tag: [t.color, t.constant(t.name), t.standard(t.name), t.atom, t.bool, t.special(t.variableName)],
    color: 'var(--syn-constant)',
  },
  { tag: [t.definition(t.name), t.separator], color: 'var(--text)' },
  {
    tag: [t.typeName, t.className, t.number, t.changed, t.annotation, t.modifier, t.self, t.namespace],
    color: 'var(--syn-type)',
  },
  {
    tag: [t.operator, t.operatorKeyword, t.url, t.escape, t.regexp, t.link, t.special(t.string)],
    color: 'var(--syn-operator)',
  },
  { tag: [t.meta, t.comment], color: 'var(--syn-comment)' },
  { tag: t.strong, fontWeight: 'bold' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.link, color: 'var(--syn-comment)', textDecoration: 'underline' },
  { tag: t.heading, fontWeight: 'bold', color: 'var(--syn-name)' },
  { tag: [t.processingInstruction, t.string, t.inserted], color: 'var(--syn-string)' },
  { tag: t.invalid, color: 'var(--syn-invalid)' },
]);
