import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { closePalette, fuzzy } from '#kernel/pick';
import { closeConfirm, closePrompt, removeToast } from '#kernel/dialogs';
import { AlertDialog } from '#ui/AlertDialog';
import { Button } from '#ui/Button';
import { Dialog } from '#ui/Dialog';
import { useApp, type ConfirmRequest, type DeepReadonly, type PaletteRequest, type PromptRequest } from '#kernel/store';
import { chords } from '#kernel/keymap';
import { features } from '#kernel/registry';

/** The words each chord's hint uses. */
const CHORD_WORDS: Record<string, string> = {
  'review.accept': 'stage', 'review.reject': 'revert', 'review.unstageHunk': 'unstage', 'comments.start': 'comment',
};

function chordHint(): string {
  const cs = chords();
  const steps = cs.map((c) => `${c.next} ${CHORD_WORDS[c.command] ?? c.command}`);
  return `${cs[0]?.prefix ?? ''}, then ${steps.join(' · ')}`;
}

export function OverlayHost() {
  const s = useApp();
  return (
    <>
      {s.palette && <CommandPalette key={s.palette.id} req={s.palette} />}
      {s.confirm && <ConfirmDialog req={s.confirm} />}
      {s.prompt && <PromptDialog req={s.prompt} />}
      {features().flatMap((f) => f.overlays ?? []).filter((o) => o.isOpen()).map((o) => <o.component key={o.id} />)}
      <div className="toasts">
        {s.toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`} onClick={() => removeToast(t.id)}>{t.message}</div>
        ))}
      </div>
      {s.chord && <div className="chord">{chordHint()}</div>}
    </>
  );
}

function CommandPalette({ req }: { req: DeepReadonly<PaletteRequest> }) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  const shown = q ? req.items.filter((it) => fuzzy(it.label, q.toLowerCase())) : req.items;
  const cur = Math.min(sel, Math.max(0, shown.length - 1));
  useEffect(() => { listRef.current?.querySelector('li.on')?.scrollIntoView({ block: 'nearest' }); }, [cur, q]);
  const close = (v: unknown) => closePalette(req.id, v);
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

function PromptDialog({ req }: { req: DeepReadonly<PromptRequest> }) {
  const [value, setValue] = useState('');
  const name = value.trim();
  const close = (v: string | null) => closePrompt(req, v);
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

function ConfirmDialog({ req }: { req: DeepReadonly<ConfirmRequest> }) {
  const i = req.message.indexOf('\n');
  const title = i < 0 ? req.message : req.message.slice(0, i);
  const body = i < 0 ? undefined : req.message.slice(i + 1);
  return <AlertDialog title={title} body={body} confirmLabel={req.error ? 'Close' : 'OK'}
    error={req.error} onResult={(ok) => closeConfirm(req, ok)} />;
}
