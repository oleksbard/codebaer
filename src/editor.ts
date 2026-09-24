import { ChangeSet, EditorState, Transaction, type Extension } from '@codemirror/state';
import { EditorView, drawSelection, highlightActiveLine, keymap, lineNumbers } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { gotoLine, highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { LanguageDescription, codeFolding, foldKeymap, syntaxHighlighting } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { commentsExtension } from './editor-comments';
import { editorHighlight, editorTheme } from './editor-theme';
import { logError } from './log';
import {
  acceptChunk, getChunks, getOriginalDoc, goToNextChunk, goToPreviousChunk, rejectChunk,
  unifiedMergeView, updateOriginalDoc,
} from '@codemirror/merge';

export type ViewKind = 'unstaged' | 'staged' | 'plain';
export { acceptChunk, rejectChunk, goToNextChunk, goToPreviousChunk, getOriginalDoc };

/** The controller registers its cursor handler here: every state built below reports selection
 *  and document changes through it, and editor.ts cannot import the controller (cycle). */
export const onCursor = { run: () => {} };

async function languageFor(path: string): Promise<Extension> {
  const desc = LanguageDescription.matchFilename(languages, path);
  if (!desc) return [];
  try {
    return await desc.load();
  } catch (e) {
    // support packages are fetched on demand, and highlighting is never worth refusing to open a
    // file over: this is the same empty extension a name we do not recognise already gets
    logError(e, `language for ${path}`);
    return [];
  }
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
    editorTheme,
    syntaxHighlighting(editorHighlight),
    codeFolding({
      preparePlaceholder: (state, range) => state.doc.lineAt(range.to).number - state.doc.lineAt(range.from).number + 1,
      placeholderDOM: (_view, onclick, lines: number) => {
        // a button, not CodeMirror's default span: expanding a gap is the only way to see the
        // hidden lines, so it has to be reachable by keyboard and announced as an action
        const el = document.createElement('button');
        el.type = 'button';
        el.className = 'cm-foldPlaceholder';
        el.title = 'unfold';
        el.setAttribute('aria-label', `expand ${lines} hidden line${lines === 1 ? '' : 's'}`);
        el.textContent = `⋯ ${lines} line${lines === 1 ? '' : 's'}`;
        el.onclick = onclick;
        return el;
      },
    }),
    await languageFor(path),
    commentsExtension,
    keymap.of([...defaultKeymap, ...searchKeymap, ...foldKeymap, { key: 'Ctrl-g', run: gotoLine }]),
    EditorView.editable.of(kind !== 'staged'),
    EditorView.updateListener.of((u) => {
      // a refresh's replaceDoc annotates addToHistory:false; only real edits should arm autosave
      if (u.docChanged && !u.transactions.every((t) => t.annotation(Transaction.addToHistory) === false)) onDocChange();
      if (u.selectionSet || u.docChanged) onCursor.run();
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
              // findFromDOM looks for .cm-content *below* what it is given, so the button itself
              // always resolves to null and leaves the cursor on whichever chunk it was already on
              const root = b.closest<HTMLElement>('.cm-editor');
              const v = root && EditorView.findFromDOM(root);
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
