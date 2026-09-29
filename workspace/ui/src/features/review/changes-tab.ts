import { buildQueue, rowKey } from '#core/model';
import { closeFile, openRow } from '#core/session';
import { notify, S } from '#kernel/store';
import { onPage } from './all-changes';

/** Coming to the Changes tab lands on something to review: a file from the queue stays open, and anything else
 *  gives way to the first file left to review, or to the page saying nothing is left. */
export async function showChanges(): Promise<void> {
  if (S.tab === 'changes') return;
  const from = S.tab;
  S.tab = 'changes';
  notify();
  if (onPage() || !S.status) return;
  const q = buildQueue(S.status);
  if ([...q.unstaged, ...q.staged].some((r) => rowKey(r) === S.selected)) return;
  const { open, selected } = S;
  const first = q.unstaged[0];
  if (first) await openRow(first);
  else if (open) await closeFile();
  // Cancel on the save prompt keeps the file, and the tab it was open in with it. An open that started meanwhile
  // has moved the selection, so it does not read as a cancel.
  if (open && S.open === open && S.selected === selected) {
    S.tab = from;
    notify();
  }
}
