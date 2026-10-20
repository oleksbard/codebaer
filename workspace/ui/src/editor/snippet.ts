import { syntaxHighlighting } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { highlightCode } from '@lezer/highlight';
import { loadLanguage } from './editor';
import { editorHighlight } from './editor-theme';

/** A run of text and the editor's highlight classes for it; `cls` is empty for plain text. */
export type Token = { text: string; cls: string };

/** Lines that start further into the file than this are parsed alone, which guesses their context, rather than
 *  parsing everything above them. */
const CONTEXT_MAX = 256 * 1024;

let styled = false;

/** The highlight classes have rules only once a view mounts them on the document, and a view may never have. */
function mountStyles(): void {
  if (styled) return;
  styled = true;
  new EditorView({ state: EditorState.create({ extensions: syntaxHighlighting(editorHighlight) }) }).destroy();
}

/** Lines `first` to `last` of `text`, 1-based and clamped to the text, highlighted as the editor would. */
export async function highlightLines(path: string, text: string, first: number, last: number): Promise<Token[][]> {
  const lines = text.split('\n');
  const top = Math.min(Math.max(1, first), lines.length);
  const end = Math.min(lines.length, Math.max(top, last));
  let from = 0;
  for (let i = 0; i < top - 1; i++) from += lines[i]!.length + 1;
  let to = from;
  for (let i = top - 1; i < end; i++) to += lines[i]!.length + 1;
  to = Math.max(from, to - 1);
  const plain = (): Token[][] => lines.slice(top - 1, end).map((l) => [{ text: l, cls: '' }]);
  const support = await loadLanguage(path);
  if (!support) return plain();
  const alone = from > CONTEXT_MAX;
  const code = text.slice(alone ? from : 0, to);
  const out: Token[][] = [[]];
  try {
    mountStyles();
    const tree = support.language.parser.parse(code);
    highlightCode(code, tree, editorHighlight, (t, cls) => out[out.length - 1]!.push({ text: t, cls }),
      () => out.push([]), alone ? 0 : from, code.length);
  } catch {
    return plain();
  }
  return out;
}
