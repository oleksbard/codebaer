import { ChangeSet, EditorState, Transaction, type Extension } from '@codemirror/state';
import { EditorView, drawSelection, highlightActiveLine, keymap, lineNumbers } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { gotoLine, highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { oneDark } from '@codemirror/theme-one-dark';
import {
  acceptChunk, getChunks, getOriginalDoc, goToNextChunk, goToPreviousChunk, rejectChunk, unifiedMergeView, updateOriginalDoc,
} from '@codemirror/merge';

export type ViewKind = 'unstaged' | 'staged' | 'plain';
export { acceptChunk, rejectChunk, goToNextChunk, goToPreviousChunk, getOriginalDoc };

async function languageFor(path: string): Promise<Extension> {
  const desc = LanguageDescription.matchFilename(languages, path);
  return desc ? await desc.load() : [];
}

export async function buildState(
  kind: ViewKind,
  path: string,
  doc: string,
  original: string | null,
  onDocChange: () => void,
  controls?: { accept(): void; reject(): void },
): Promise<EditorState> {
  const ext: Extension[] = [
    lineNumbers(),
    highlightActiveLine(),
    drawSelection(),
    highlightSelectionMatches(),
    oneDark,
    await languageFor(path),
    keymap.of([...defaultKeymap, ...searchKeymap, { key: 'Ctrl-g', run: gotoLine }]),
    EditorView.editable.of(kind !== 'staged'),
    EditorView.updateListener.of((u) => {
      // a refresh's replaceDoc annotates addToHistory:false; only real edits should arm autosave
      if (u.docChanged && !u.transactions.every((t) => t.annotation(Transaction.addToHistory) === false)) onDocChange();
    }),
  ];
  if (kind !== 'staged') ext.push(history(), keymap.of(historyKeymap));
  if (kind !== 'plain') {
    ext.push(unifiedMergeView({
      original: original ?? '',
      mergeControls: controls
        ? (type, _action) => {
            const b = document.createElement('button');
            b.textContent = type === 'accept' ? 'Accept' : 'Reject';
            b.name = type; // matches the library's own [name=accept]/[name=reject] baseTheme styling
            b.onclick = (e) => {
              e.preventDefault();
              const v = EditorView.findFromDOM(b);
              if (v) v.dispatch({ selection: { anchor: v.posAtDOM(b) } });
              (type === 'accept' ? controls.accept : controls.reject)();
            };
            return b;
          }
        : false,
      highlightChanges: true,
      gutter: true,
    }));
  }
  return EditorState.create({ doc, extensions: ext });
}

export function replaceDoc(view: EditorView, text: string): void {
  const head = Math.min(view.state.selection.main.head, text.length);
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: text },
    selection: { anchor: head },
    annotations: Transaction.addToHistory.of(false),
  });
}

export function replaceOriginal(view: EditorView, text: string): void {
  const orig = getOriginalDoc(view.state);
  const changes = ChangeSet.of({ from: 0, to: orig.length, insert: text }, orig.length);
  view.dispatch({ effects: updateOriginalDoc.of({ doc: changes.apply(orig), changes }) });
}

export function chunkCount(state: EditorState): number {
  return getChunks(state)?.chunks.length ?? 0;
}

export function chunkIndexAtCursor(state: EditorState): number {
  const chunks = getChunks(state)?.chunks ?? [];
  const pos = state.selection.main.head;
  return chunks.findIndex((c) => c.fromB <= pos && pos <= c.endB);
}
