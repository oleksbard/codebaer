import { pinDefaultBranches } from '#core/model';
import { guarded, offerSave, refresh, withBusy } from '#core/session';
import { errKind, errText, git, type Branch, type Stash, type StashKind } from '#ipc/git';
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

/** The AI's description of what the stash takes, or null: with the AI off or failing the stash goes on without one. */
async function describe(kind: StashKind): Promise<string | null> {
  if (S.settings['general.headless-ai-provider'] === 'off') return null;
  try {
    return await git.aiStashDescription(kind);
  } catch (e) {
    toast(`Stashing without a description\n${errText(e)}`, 'warn');
    return null;
  }
}

let stashing = false;

/** A staged stash takes only the index, so the open file's unsaved changes are no concern of it. */
export async function stash(kind: StashKind): Promise<void> {
  if (stashing) return;
  stashing = true;
  try {
    const go = kind === 'staged' || await offerSave(
      (name) => `${name} has unsaved changes\nThey are not stashed unless you save them first.`,
      'Save & Stash', 'Stash Anyway');
    const root = S.root;
    if (!go || root === null) return;
    const done = await guarded(async () => {
      const message = await describe(kind);
      // the AI can take a minute, and the stash must not land on a repo opened meanwhile; the backend checks too,
      // since it switches before S.root does
      if (S.root !== root) return 'moved';
      return (await git.stashPush(root, kind, message)) ? 'stashed' : 'nothing';
    });
    if (done === 'nothing') toast('No local changes to save', 'info');
    if (done === 'moved') toast('Nothing was stashed: another repository was opened', 'info');
  } finally {
    stashing = false;
  }
}

const AGE: [Intl.RelativeTimeFormatUnit, number][] = [
  ['second', 60], ['minute', 60], ['hour', 24], ['day', 30], ['month', 12], ['year', Infinity],
];
const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

export function age(time: number, now = Date.now()): string {
  let n = Math.max(0, now / 1000 - time);
  for (const [unit, per] of AGE) {
    if (n < per) return unit === 'second' ? 'just now' : relative.format(-Math.floor(n), unit);
    n /= per;
  }
  return '';
}

export const stashLabel = (s: Stash): string => (s.wip ? `WIP on ${s.message}` : s.message);

export async function unstash(): Promise<void> {
  let list: Stash[];
  try { list = await git.stashList(); } catch (e) { toast(errText(e), 'err'); return; }
  if (!list.length) { toast('No stashes to restore', 'info'); return; }
  const now = Date.now();
  const picked = await pick(list.map((s) => ({
    label: stashLabel(s), note: [s.branch, age(s.time, now)].filter(Boolean).join(' · '), value: s,
  })), 'Select a stash to restore');
  if (!picked) return;
  await guarded(() => git.stashPop(picked.index, picked.oid));
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
  else if (b) await guarded(() => git.switchBranch(b));
}

export async function createBranch(): Promise<void> {
  const name = await promptDialog('New branch name');
  if (name) await guarded(() => git.createBranch(name));
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
