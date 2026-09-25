import { useEffect, useState } from 'react';
import {
  HEALTHY, ORPHANED, orphanRows, sockName, STATUS, type OrphanAction, type OrphanRow, type OrphanScan,
} from '../orphans';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { REFRESH, StrokeIcon } from '../ui/Icon';
import { IconButton } from '../ui/IconButton';
import { Pill } from '../ui/Pill';
import { closeOrphans, orphanAction, rescan } from './controller';

const ARM_MS = 3000;
const RESTORE = ['Restore', 'Restoring…'];
const KILL = ['Kill', 'Confirm kill', 'Killing…'];

/** Every label a button can show, stacked, so it is always as wide as the longest and a label
 *  change cannot reflow the table. Only the current one is visible to anyone. */
function Labels({ all, show }: { all: string[]; show: string }) {
  return (
    <span className="labels">
      {all.map((l) => <span key={l} className={l === show ? '' : 'off'}>{l}</span>)}
    </span>
  );
}

export function OrphansDialog({ scan }: { scan: OrphanScan }) {
  const { report } = scan;
  const [busy, setBusy] = useState<{ key: string; what: 'restore' | 'kill' } | null>(null);
  const [armed, setArmed] = useState<string | null>(null);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(null), ARM_MS);
    return () => clearTimeout(t);
  }, [armed]);

  const rows = orphanRows(report, scan.listed);
  const found = rows.filter((r) => ORPHANED.has(r.status)).length;
  const run = async (row: OrphanRow, a: OrphanAction, what: 'restore' | 'kill') => {
    setArmed(null);
    setBusy({ key: row.key, what });
    await orphanAction(a);
    setBusy(null);
  };
  // a kill cannot be taken back, so it asks twice rather than opening a second dialog over this one
  const kill = (row: OrphanRow, a: OrphanAction) => {
    if (armed === row.key) void run(row, a, 'kill');
    else setArmed(row.key);
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) closeOrphans(); }} title="Terminals and orphans"
      className="orphans">
      <div className="orphans-head">
        {/* the dialog is already named by its hidden title */}
        <h2 className="dialog-title" aria-hidden="true">Terminals and orphans</h2>
        <span className="orphans-found">{found ? `${found} orphaned` : 'nothing orphaned'}</span>
        <IconButton label="Rescan" disabled={busy !== null} onClick={() => void rescan()}>
          <StrokeIcon d={REFRESH} size={14} />
        </IconButton>
      </div>
      <div className="orphans-hosts">
        {report.hosts.length === 0 && <Pill>no pty host running</Pill>}
        {report.hosts.map((h) => (
          <Pill key={h.pid} tone={h.current ? 'default' : 'warn'}>
            {sockName(h.sock)} · pid {h.pid} · {h.current ? 'current'
              : h.unclear ? 'shares its socket path' : h.in_use ? 'in use' : 'stale'}
            {h.sock_exists || h.unclear ? '' : ', socket gone'}
          </Pill>
        ))}
      </div>
      {rows.length
        ? (
            <div className="orphans-scroll">
              <table className="orphans-table">
                <thead>
                  <tr>
                    <th>Status</th><th aria-label="Session">#</th><th>PID</th><th>TTY</th><th>Command</th>
                    <th>Host</th><th><span className="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.key} className={busy?.key === r.key ? 'busy' : ''}>
                      <td><Pill tone={HEALTHY.has(r.status) ? 'default' : 'warn'}>{STATUS[r.status]}</Pill></td>
                      <td className="num">{r.session ?? ''}</td>
                      <td className="num">{r.pid ?? ''}</td>
                      <td className="num">{r.tty}</td>
                      <td className="cmd" title={r.command}>{r.command}</td>
                      <td className="host">{r.host}</td>
                      <td className="actions">
                        {r.why && <span className="why">{r.why}</span>}
                        {r.restore && (
                          <Button disabled={busy !== null} busy={busy?.key === r.key && busy.what === 'restore'}
                            onClick={() => { if (r.restore) void run(r, r.restore, 'restore'); }}>
                            <Labels all={RESTORE}
                              show={busy?.key === r.key && busy.what === 'restore' ? 'Restoring…' : 'Restore'} />
                          </Button>
                        )}
                        {r.kill && (
                          <Button className={armed === r.key ? 'armed' : ''} disabled={busy !== null}
                            busy={busy?.key === r.key && busy.what === 'kill'}
                            onClick={() => { if (r.kill) kill(r, r.kill); }}>
                            <Labels all={KILL} show={busy?.key === r.key && busy.what === 'kill' ? 'Killing…'
                              : armed === r.key ? 'Confirm kill' : 'Kill'} />
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        : <p className="dialog-body">No terminals, and no pty host processes on this machine.</p>}
      <div className="dialog-actions">
        <Button variant="primary" onClick={closeOrphans}>Close</Button>
      </div>
    </Dialog>
  );
}
