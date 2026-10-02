import {
  Decoration, MatchDecorator, ViewPlugin, type DecorationSet, type EditorView, type ViewUpdate,
} from '@codemirror/view';
import { S, subscribe } from '#kernel/store';

/** The editor theme already styles CodeMirror's own find matches this way. */
const mark = Decoration.mark({ class: 'cm-searchMatch' });

/** Marked only while the Search tab shows, as VS Code marks a search's matches in the open file. */
const wanted = (): string => (S.tab === 'search' ? S.searchQuery : '');

/** The backend's rules: literal, and case-blind unless the query has a capital. */
function decorator(query: string): MatchDecorator | null {
  if (!query) return null;
  const literal = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regexp = new RegExp(literal, query === query.toLowerCase() ? 'gi' : 'g');
  return new MatchDecorator({ regexp, decoration: mark });
}

export const searchMarks = ViewPlugin.fromClass(class {
  query = wanted();
  matcher = decorator(this.query);
  decorations: DecorationSet;
  unsubscribe: () => void;

  constructor(view: EditorView) {
    this.decorations = this.matcher?.createDeco(view) ?? Decoration.none;
    // the query and the tab live in the store, which tells no editor when they change; a microtask, because a
    // notify() can come from inside an editor update, where dispatching throws
    this.unsubscribe = subscribe(() => {
      if (wanted() !== this.query) queueMicrotask(() => { if (wanted() !== this.query) view.dispatch({}); });
    });
  }

  update(u: ViewUpdate): void {
    const query = wanted();
    if (query !== this.query) {
      this.query = query;
      this.matcher = decorator(query);
      this.decorations = this.matcher?.createDeco(u.view) ?? Decoration.none;
    } else if (this.matcher) {
      this.decorations = this.matcher.updateDeco(u, this.decorations);
    }
  }

  destroy(): void {
    this.unsubscribe();
  }
}, { decorations: (p) => p.decorations });
