import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { fuzzy } from '../palette';
import { removeToast } from '../toast';
import { AlertDialog } from '../ui/AlertDialog';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { notify, S, useApp, type ConfirmRequest, type PaletteRequest, type PromptRequest } from './store';

export function Overlays() {
  useApp();
  return (
    <>
      {S.palette && <CommandPalette key={S.palette.id} req={S.palette} />}
      {S.confirm && <ConfirmDialog req={S.confirm} />}
      {S.prompt && <PromptDialog req={S.prompt} />}
      <div className="toasts">
        {S.toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`} onClick={() => removeToast(t.id)}>{t.message}</div>
        ))}
      </div>
      {S.chord && <div className="chord">⌘K, then ⌘⌥S stage · ⌘R revert · ⌘N unstage</div>}
    </>
  );
}

function CommandPalette({ req }: { req: PaletteRequest }) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  const shown = q ? req.items.filter((it) => fuzzy(it.label, q.toLowerCase())) : req.items;
  const cur = Math.min(sel, Math.max(0, shown.length - 1));
  useEffect(() => { listRef.current?.querySelector('li.on')?.scrollIntoView({ block: 'nearest' }); }, [cur, q]);
  const close = (v: unknown) => {
    if (S.palette !== req) return;
    S.palette = null;
    notify();
    req.resolve(v);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') { setSel(Math.min(shown.length - 1, cur + 1)); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { setSel(Math.max(0, cur - 1)); e.preventDefault(); }
    else if (e.key === 'Enter') { e.preventDefault(); close(shown[cur]?.value ?? null); }
  };
  return (
    <Dialog open onOpenChange={(open) => { if (!open) close(null); }} title={req.placeholder} className="pal">
      <input type="text" autoComplete="off" spellCheck={false} placeholder={req.placeholder} value={q}
        onChange={(e) => { setQ(e.target.value); setSel(0); }} onKeyDown={onKeyDown} />
      <ul ref={listRef}>
        {shown.length
          ? shown.map((it, i) => (
              <li key={i} className={i === cur ? 'on' : ''} onClick={() => close(it.value)}>
                <span>{it.label}{it.detail ? <> <span className="desc">{it.detail}</span></> : null}</span>
                {it.hint ? <span className="k">{it.hint}</span> : null}
              </li>
            ))
          : <li className="desc">No matching results</li>}
      </ul>
    </Dialog>
  );
}

function PromptDialog({ req }: { req: PromptRequest }) {
  const [value, setValue] = useState('');
  const name = value.trim();
  const close = (v: string | null) => {
    if (S.prompt !== req) return;
    S.prompt = null;
    notify();
    req.resolve(v);
  };
  return (
    <Dialog open onOpenChange={(open) => { if (!open) close(null); }} title={req.placeholder} className="prompt">
      <input autoFocus type="text" autoComplete="off" spellCheck={false} placeholder={req.placeholder} value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (name) close(name); } }} />
      <div className="dialog-actions">
        <Button onClick={() => close(null)}>Cancel</Button>
        <Button variant="primary" disabled={!name} onClick={() => close(name)}>Create</Button>
      </div>
    </Dialog>
  );
}

function ConfirmDialog({ req }: { req: ConfirmRequest }) {
  const i = req.message.indexOf('\n');
  const title = i < 0 ? req.message : req.message.slice(0, i);
  const body = i < 0 ? undefined : req.message.slice(i + 1);
  const close = (ok: boolean) => {
    // Radix reports the close after our OK handler already resolved, so the second call is a no-op
    if (S.confirm !== req) return;
    S.confirm = null;
    notify();
    req.resolve(ok);
  };
  return <AlertDialog title={title} body={body} confirmLabel={req.error ? 'Close' : 'OK'}
    error={req.error} onResult={close} />;
}
