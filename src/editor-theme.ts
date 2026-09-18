import { EditorView } from '@codemirror/view';
import { HighlightStyle } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

// ponytail: dark is fixed; a Compartment swaps this flag when a non-dark palette exists
export const editorTheme = EditorView.theme(
  {
    '&': { color: 'var(--text)', backgroundColor: 'var(--bg)' },
    '.cm-content': { caretColor: 'var(--text)' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--text)' },
    '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
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
  },
  { dark: true },
);

export const editorHighlight = HighlightStyle.define([
  { tag: t.keyword, color: 'var(--syn-keyword)' },
  { tag: [t.name, t.deleted, t.character, t.propertyName, t.macroName], color: 'var(--syn-name)' },
  { tag: [t.function(t.variableName), t.labelName], color: 'var(--syn-function)' },
  { tag: [t.color, t.constant(t.name), t.standard(t.name), t.atom, t.bool, t.special(t.variableName)], color: 'var(--syn-constant)' },
  { tag: [t.definition(t.name), t.separator], color: 'var(--text)' },
  { tag: [t.typeName, t.className, t.number, t.changed, t.annotation, t.modifier, t.self, t.namespace], color: 'var(--syn-type)' },
  { tag: [t.operator, t.operatorKeyword, t.url, t.escape, t.regexp, t.link, t.special(t.string)], color: 'var(--syn-operator)' },
  { tag: [t.meta, t.comment], color: 'var(--syn-comment)' },
  { tag: t.strong, fontWeight: 'bold' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.link, color: 'var(--syn-comment)', textDecoration: 'underline' },
  { tag: t.heading, fontWeight: 'bold', color: 'var(--syn-name)' },
  { tag: [t.processingInstruction, t.string, t.inserted], color: 'var(--syn-string)' },
  { tag: t.invalid, color: 'var(--syn-invalid)' },
]);
