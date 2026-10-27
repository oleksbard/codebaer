import { highlightSelectionMatches, SearchCursor } from '@codemirror/search';
import type { EditorState, Extension } from '@codemirror/state';
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';

// past this many, a mark per match would paint the whole strip and tell nothing
const MAX_MARKS = 2000;

/** The start of every match of the selection in the document, the selection's own included, under the rules of
 *  highlightSelectionMatches' defaults: one non-empty range of at most 200 characters. Empty when nothing else
 *  matches. */
export function matchStarts(state: EditorState): number[] {
  const sel = state.selection;
  if (sel.ranges.length > 1) return [];
  const { from, to } = sel.main;
  if (to - from < 1 || to - from > 200) return [];
  const starts: number[] = [];
  const cursor = new SearchCursor(state.doc, state.sliceDoc(from, to));
  while (!cursor.next().done) {
    starts.push(cursor.value.from);
    if (starts.length > MAX_MARKS) return [];
  }
  return starts.length > 1 ? starts : [];
}

type Layout = { top: number; height: number; ys: number[] };

/** A strip over the scrollbar with a mark at the height of each match, so matches outside the viewport show. */
const marks = ViewPlugin.fromClass(class {
  readonly dom = document.createElement('div');
  starts: number[];

  constructor(view: EditorView) {
    this.dom.className = 'cm-matchMarks';
    this.dom.setAttribute('aria-hidden', 'true');
    view.dom.appendChild(this.dom);
    this.starts = matchStarts(view.state);
    this.measure(view);
  }

  update(u: ViewUpdate): void {
    if (u.selectionSet || u.docChanged) this.starts = matchStarts(u.state);
    if (u.selectionSet || u.docChanged || u.geometryChanged || u.heightChanged) this.measure(u.view);
  }

  measure(view: EditorView): void {
    view.requestMeasure<Layout>({
      key: this,
      read: (v) => {
        const s = v.scrollDOM;
        const total = s.scrollHeight;
        if (!this.starts.length || !total) return { top: 0, height: 0, ys: [] };
        const docTop = v.documentTop - s.getBoundingClientRect().top + s.scrollTop;
        const ys = new Set(this.starts.map((p) => Math.round(((docTop + v.lineBlockAt(p).top) / total)
          * s.clientHeight)));
        return { top: s.offsetTop, height: s.clientHeight, ys: [...ys] };
      },
      write: ({ top, height, ys }) => {
        this.dom.style.top = `${top}px`;
        this.dom.style.height = `${height}px`;
        this.dom.replaceChildren(...ys.map((y) => {
          const m = document.createElement('div');
          m.className = 'cm-matchMark';
          m.style.top = `${Math.min(y, height - 2)}px`;
          return m;
        }));
      },
    });
  }

  destroy(): void {
    this.dom.remove();
  }
});

export const selectionMatches: Extension = [highlightSelectionMatches(), marks];
