import { onCursor } from '#editor/editor';
import { defineFeature } from '#kernel/registry';
import { S } from '#kernel/store';
import { cursorMoved } from './blame';
import {
  accept, acceptFile, discardAll, nextFile, nextHunk, reject, rejectFile, stageAll, unstageAll, unstageFile,
  unstageHunk,
} from './hunks';

// wired where the feature is defined: every open, refresh and cursor move ends in onCursor.run
onCursor.run = cursorMoved;

export const review = defineFeature({
  id: 'review',
  commands: [
    { id: 'review.stageAll', label: 'Git: Stage All Changes', run: stageAll },
    { id: 'review.unstageAll', label: 'Git: Unstage All Changes', run: unstageAll },
    { id: 'review.discardAll', label: 'Git: Discard All Changes', run: discardAll },
    { id: 'review.stageFile', label: 'Git: Stage File', run: () => S.open && acceptFile(S.open.path) },
    { id: 'review.discardFile', label: 'Git: Discard File', run: () => S.open && rejectFile(S.open.path) },
    { id: 'review.unstageFile', label: 'Git: Unstage File', run: () => S.open && unstageFile(S.open.path) },
    { id: 'review.nextHunk', run: () => nextHunk(1) },
    { id: 'review.prevHunk', run: () => nextHunk(-1) },
    { id: 'review.accept', run: accept },
    { id: 'review.reject', run: reject },
    { id: 'review.unstageHunk', run: unstageHunk },
    { id: 'review.nextFile', run: () => nextFile(1) },
    { id: 'review.prevFile', run: () => nextFile(-1) },
  ],
});

export { QueueList } from './Queue';
export { ReviewPane } from './ReviewPane';
