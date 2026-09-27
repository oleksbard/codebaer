import { onCursor } from '#editor/editor';
import { toast } from '#kernel/dialogs';
import { defineFeature } from '#kernel/registry';
import { S } from '#kernel/store';
import {
  dropPage, onPage, stackAccept, stackFile, stackHunk, stackPath, stackReject, syncAllChanges,
  toggleAllChanges,
} from './all-changes';
import { cursorMoved } from './blame';
import {
  accept, acceptFile, discardAll, nextFile, nextHunk, reject, rejectFile, stageAll, unstageAll, unstageFile,
  unstageHunk,
} from './hunks';

// wired where the feature is defined: every open, refresh and cursor move ends in onCursor.run
onCursor.run = () => {
  // a file in the main pane ends the All changes page, whoever opened it and even when it failed to read
  if (S.open && S.allChanges) dropPage();
  cursorMoved();
};

/** The whole-file keys act on the open file, or on the All changes page on the one being read. */
function onFile(fn: (path: string) => Promise<unknown>): Promise<unknown> | undefined {
  if (!onPage()) return S.open ? fn(S.open.path) : undefined;
  const p = stackPath();
  if (p !== null) return fn(p);
  toast('Put the cursor in a file still to review first', 'info');
  return undefined;
}

export const review = defineFeature({
  id: 'review',
  commands: [
    { id: 'review.stageAll', label: 'Git: Stage All Changes', run: stageAll },
    { id: 'review.unstageAll', label: 'Git: Unstage All Changes', run: unstageAll },
    { id: 'review.discardAll', label: 'Git: Discard All Changes', run: discardAll },
    { id: 'review.stageFile', label: 'Git: Stage File', run: () => onFile(acceptFile) },
    { id: 'review.discardFile', label: 'Git: Discard File', run: () => onFile(rejectFile) },
    { id: 'review.unstageFile', label: 'Git: Unstage File', run: () => S.open && unstageFile(S.open.path) },
    { id: 'review.allChanges', label: 'Show All Changes', when: () => !onPage(), run: toggleAllChanges },
    { id: 'review.nextHunk', run: () => (onPage() ? stackHunk(1) : nextHunk(1)) },
    { id: 'review.prevHunk', run: () => (onPage() ? stackHunk(-1) : nextHunk(-1)) },
    { id: 'review.accept', run: () => (onPage() ? stackAccept() : accept()) },
    { id: 'review.reject', run: () => (onPage() ? stackReject() : reject()) },
    { id: 'review.unstageHunk', run: unstageHunk },
    { id: 'review.nextFile', run: () => (onPage() ? stackFile(1) : nextFile(1)) },
    { id: 'review.prevFile', run: () => (onPage() ? stackFile(-1) : nextFile(-1)) },
  ],
  onRefresh: syncAllChanges,
  onRepoChange: { reset: dropPage },
});

export { QueueList } from './Queue';
export { ReviewPane } from './ReviewPane';
export { AllChanges } from './AllChanges';
export { allChangesShown, rethemeAllChanges } from './all-changes';
