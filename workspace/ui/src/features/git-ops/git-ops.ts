import { pinDefaultBranches } from '#core/model';
import { flush, guarded, refresh, withBusy } from '#core/session';
import { errKind, errText, git, type Branch } from '#ipc/git';
import { errorDialog, promptDialog, toast } from '#kernel/dialogs';
import { pick, type Item } from '#kernel/pick';
import { notify, refs, S } from '#kernel/store';
import { fetched } from './auto-fetch';

export async function commit(): Promise<void> {
  if (S.committing) return;
  const msg = S.commitMessage.trim();
  if (!msg) { toast('Type a commit message first', 'err'); refs.commit?.focus(); return; }
  S.committing = true;
  notify();
  try {
    await git.commit(msg);
    S.commitMessage = '';
    toast('Committed', 'ok');
  } catch (e) {
    void errorDialog(`Commit failed\n${errText(e)}`);
  } finally {
    S.committing = false;
    notify();
  }
  void refresh();
}

export async function aiMessage(): Promise<void> {
  S.aiBusy = true;
  notify();
  try {
    S.commitMessage = await git.aiCommitMessage();
    notify();
    refs.commit?.focus();
  } catch (e) {
    toast(errText(e), 'err');
  } finally {
    S.aiBusy = false;
    notify();
  }
}

const NET: Record<Net, { verb: string; done: string; run: () => Promise<void> }> = {
  push: { verb: 'Push', done: 'Pushed', run: () => git.push() },
  pull: { verb: 'Pull', done: 'Pulled', run: () => git.pull() },
  fetch: { verb: 'Fetch', done: 'Fetched', run: () => git.fetch() },
};

export type Net = 'push' | 'pull' | 'fetch';

export async function network(name: Net): Promise<void> {
  if (name === 'pull' && !(await flush())) return;
  S.cancellable = true;
  try {
    await withBusy(NET[name].run);
    if (name !== 'push') fetched();
    toast(NET[name].done, 'ok');
  } catch (e) {
    if (errKind(e) === 'Cancelled') toast('Cancelled', 'info');
    else void errorDialog(`${NET[name].verb} failed\n${errText(e)}`);
  } finally {
    S.cancellable = false;
    notify();
    await refresh();
    const st = await git.status().catch(() => null);
    const conflicts = st?.files.filter((f) => f.conflicted).map((f) => f.path) ?? [];
    if (conflicts.length) {
      const n = conflicts.length;
      const lead = `${name} left ${n} conflict${n > 1 ? 's' : ''}:`;
      toast(`${lead}\n  ${conflicts.join('\n  ')}\nFix the markers, then stage the file.`, 'warn');
    }
  }
}

export async function stashPop(): Promise<void> {
  await guarded('stashPop', () => git.stashPop());
  const st = await git.status().catch(() => null);
  const conflicts = st?.files.filter((f) => f.conflicted).map((f) => f.path) ?? [];
  if (conflicts.length) toast(`stash pop left conflicts:\n  ${conflicts.join('\n  ')}`, 'warn');
}

export async function checkout(): Promise<void> {
  let bs: Branch[] = [];
  try { bs = await git.branches(); } catch (e) { toast(errText(e), 'err'); return; }
  const opts: Item<Branch | 'create'>[] = [
    { label: '+ Create new branch…', value: 'create' },
    ...pinDefaultBranches(bs).map((br) => ({
      label: br.kind === 'local' ? br.name : `${br.remote}/${br.branch}`, detail: br.kind, value: br,
    })),
  ];
  const b = await pick(opts, 'Select a branch to checkout');
  if (b === 'create') await createBranch();
  else if (b) await guarded('switchBranch', () => git.switchBranch(b));
}

export async function createBranch(): Promise<void> {
  const name = await promptDialog('New branch name');
  if (name) await guarded('createBranch', () => git.createBranch(name));
}

export const cancel = (): Promise<void> => git.cancel();

export function focusCommit(): void {
  S.tab = 'changes';
  notify();
  // React applies the tab change in a microtask queued by notify(); the focus has to land after it
  queueMicrotask(() => refs.commit?.focus());
}

export function setCommitMessage(text: string): void {
  S.commitMessage = text;
  notify();
}
