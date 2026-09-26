import { defineFeature } from '#kernel/registry';
import { S } from '#kernel/store';
import {
  confirmRepoChange, discardComments, saveDraft, sendComments, showComments, startComment, syncComments,
} from './actions';
import { commentsExtension, onComments } from './editor-comments';

onComments.run = syncComments;

const pending = (): boolean => S.comments.length > 0;

export const comments = defineFeature({
  id: 'comments',
  commands: [
    { id: 'comments.start', label: 'Comment on Selection', run: startComment },
    { id: 'comments.send', label: 'Send Pending Comments…', when: pending, run: sendComments },
    { id: 'comments.discard', label: 'Discard Pending Comments', when: pending, run: discardComments },
    { id: 'comments.save', run: saveDraft },
  ],
  editorExtensions: [commentsExtension],
  onOpen: showComments,
  onRepoChange: { confirm: confirmRepoChange, reset: () => { S.comments = []; S.draft = null; } },
});

export { CommentLayer, PendingPill } from './CommentLayer';
