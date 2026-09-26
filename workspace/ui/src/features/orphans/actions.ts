import { errText } from '#ipc/git';
import { logError } from '#ipc/log';
import * as pty from '#ipc/terminal';
import * as term from '#features/terminals';
import { toast } from '#kernel/dialogs';
import { epoch } from '#kernel/epoch';
import { idle } from '#kernel/registry';
import { sleep } from '#kernel/sleep';
import { notify, S } from '#kernel/store';
import { orphanRows, type OrphanAction, type OrphanScan } from './orphans';

/** The sidebar's list is copied before the processes are listed, never after: a terminal opened in
 *  between is then at worst a process with no entry, never an entry with no process, which is the
 *  kind that gets offered a Kill. */
async function takeScan(): Promise<OrphanScan> {
  const listed = [...S.terminals];
  return { report: await pty.orphans(), listed };
}

/** Bumped per opening, so a scan started for one dialog cannot land in the next. */
const orphansEpoch = epoch();

export async function findOrphans(): Promise<void> {
  const live = orphansEpoch.next();
  try {
    const scan = await takeScan();
    // something else took the screen meanwhile, or this was opened again
    if (!live() || !idle('orphans')) return;
    S.orphans = scan;
  } catch (e) {
    logError(e, 'find orphans');
    toast(errText(e), 'err');
  }
  notify();
}

export function closeOrphans(): void {
  orphansEpoch.bump();
  S.orphans = null;
  notify();
}

/** Rescans until `pid` is gone, since the host signals a closed session's group after it replies. */
async function rescanOrphans(gone: number | null = null): Promise<void> {
  const live = orphansEpoch.current();
  for (let i = 0; i < 12; i++) {
    const scan = await takeScan();
    // closed, or closed and opened again, while this was in flight
    if (!S.orphans || !live()) return;
    S.orphans = scan;
    notify();
    const all = [...scan.report.hosts.flatMap((h) => h.sessions), ...scan.report.escaped];
    if (gone === null || !all.some((p) => p.pid === gone)) return;
    await sleep(250);
  }
}

/** For a session whose id could not be read: list again, then replay whatever the list gained. */
async function relistUnknown(): Promise<void> {
  const before = new Set(S.terminals.map((t) => t.id));
  await pty.relist(null);
  // the list arrives as a Hello event, not as this call's result
  for (let i = 0; i < 20 && S.terminals.every((t) => before.has(t.id)); i++) await sleep(100);
  const gained = S.terminals.filter((t) => !before.has(t.id));
  if (!gained.length) toast('The host listed no terminal the sidebar was missing, so nothing was restored.', 'err');
  for (const t of gained) await replay(t.id);
}

/** Whatever the view already holds for the session goes first, or its history shows twice. */
async function replay(id: number): Promise<void> {
  term.reset(id);
  await pty.relist(id);
  // until the list lands, a rescan's copy of it would still say the session is missing
  for (let i = 0; i < 20 && !S.terminals.some((t) => t.id === id); i++) await sleep(100);
  if (!S.terminals.some((t) => t.id === id)) toast(`The host has no terminal #${id}, so nothing was restored.`, 'err');
}

export async function rescan(): Promise<void> {
  try {
    await rescanOrphans();
  } catch (e) {
    logError(e, 'rescan orphans');
    toast(errText(e), 'err');
  }
}

export async function orphanAction(a: OrphanAction): Promise<void> {
  const live = orphansEpoch.current();
  try {
    switch (a.t) {
      case 'relist': await (a.id === null ? relistUnknown() : replay(a.id)); break;
      case 'relay': await term.restoreOrphan(a.sock, a.id, a.pid); break;
      case 'signal': await pty.killOrphan(a.pid); break;
      case 'close': {
        // the only kill the backend cannot check, since only this side knows which entry is which,
        // so a fresh scan has to agree with the row first
        const fresh = await takeScan();
        const same = orphanRows(fresh.report, fresh.listed)
          .some((r) => r.kill?.t === 'close' && r.kill.id === a.id && r.pid === a.pid);
        if (!same) {
          if (S.orphans && live()) S.orphans = fresh;
          notify();
          toast('That terminal changed since the scan. Nothing was closed; check the new one.', 'err');
          return;
        }
        await pty.close(a.id);
        // a record the host no longer has gets no Closed, and only its list can drop it
        await pty.relist(null);
        break;
      }
    }
    // the dialog this action came from may have been closed and another opened meanwhile
    if (live()) await rescanOrphans(a.t === 'close' ? a.pid : null);
  } catch (e) {
    logError(e, `orphan ${a.t}`);
    toast(errText(e), 'err');
  }
}
