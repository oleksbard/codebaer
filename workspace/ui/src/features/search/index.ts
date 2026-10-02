import { expandSide } from '#core/session';
import { defineFeature } from '#kernel/registry';
import { searchMarks } from './editor-search';
import { focusSearch, resetSearch, runSearch, searchChanged, showSearch } from './search';

export const search = defineFeature({
  id: 'search',
  commands: [
    {
      id: 'search.show', label: 'Search: Find in Files',
      run: () => { expandSide(); showSearch(); queueMicrotask(focusSearch); },
    },
    { id: 'search.run', run: () => runSearch() },
  ],
  editorExtensions: [searchMarks],
  onRefresh: searchChanged,
  onRepoChange: { reset: resetSearch },
});

export { SearchPane } from './SearchPane';
export { showSearch } from './search';
