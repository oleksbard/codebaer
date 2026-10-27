import { defineFeature } from '#kernel/registry';
import { lineMarks, loadBase } from './branch-lines';

export const branchLines = defineFeature({
  id: 'branchLines',
  editorExtensions: [lineMarks],
  onOpen: () => void loadBase(true),
  onRefresh: () => void loadBase(false),
});
