import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { closePalette, fuzzy } from '#kernel/pick';
import { copyText } from '#kernel/clipboard';
import { closeConfirm, closePrompt, holdToast, removeToast } from '#kernel/dialogs';
import { AlertDialog } from '#ui/AlertDialog';
import { Button } from '#ui/Button';
import { Dialog } from '#ui/Dialog';
import { Kbd } from '#ui/Kbd';
import { Presence } from '#ui/Presence';
import { Reveal } from '#ui/Reveal';
import { Spinner } from '#ui/Spinner';
import { Toasts } from '#ui/Toasts';
import {
  useApp, type ConfirmRequest, type DeepReadonly, type ErrorHint, type PaletteRequest, type PromptRequest,
} from '#kernel/store';
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
      {/* no exit: it answers a keystroke and must close as fast as it opened */}
      {s.palette && <CommandPalette key={s.palette.id} req={s.palette} />}
      <Presence>
        {s.confirm && <ConfirmDialog key={`confirm:${s.confirm.id}`} req={s.confirm} />}
        {s.prompt && <PromptDialog key={`prompt:${s.prompt.id}`} req={s.prompt} />}
        {features().flatMap((f) => f.overlays ?? []).filter((o) => o.isOpen()).map((o) => <o.component key={o.id} />)}
      </Presence>
      <Toasts toasts={s.toasts} onDismiss={removeToast} onHold={holdToast} />
      <Reveal when={s.chord} className="chord" kind="rise">{chordHint()}</Reveal>
    </>
  );
}

/** Go to File lists every file in the repository; past this many, typing narrows the list instead. */
const SHOWN = 200;

function CommandPalette({ req }: { req: DeepReadonly<PaletteRequest> }) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  const lower = useMemo(() => req.items.map((it) => it.label.toLowerCase()), [req.items]);
  const matched = q ? req.items.filter((_, i) => fuzzy(lower[i]!, q.toLowerCase())) : req.items;
  const shown = matched.slice(0, SHOWN);
  const cur = Math.min(sel, Math.max(0, shown.length - 1));
  useEffect(() => { listRef.current?.querySelector('li.on')?.scrollIntoView({ block: 'nearest' }); }, [cur, q]);
  const close = (v: unknown) => closePalette(req.id, v);
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') { setSel(Math.min(shown.length - 1, cur + 1)); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { setSel(Math.max(0, cur - 1)); e.preventDefault(); }
    else if (e.key === 'Enter') { e.preventDefault(); close(shown[cur]?.value ?? null); }
  };
  return (
    <Dialog open onOpenChange={(open) => { if (!open) close(null); }} title={req.placeholder}
      className={req.wide ? 'pal wide' : 'pal'}>
      <input type="text" autoComplete="off" spellCheck={false} placeholder={req.placeholder} value={q}
        onChange={(e) => { setQ(e.target.value); setSel(0); }} onKeyDown={onKeyDown} />
      <ul ref={listRef}>
        {shown.length
          ? shown.map((it, i) => (
              <Fragment key={i}>
                {!q && it.group && it.group !== shown[i - 1]?.group ? <li className="group">{it.group}</li> : null}
                <li className={[i === cur && 'on', it.dim && 'dim'].filter(Boolean).join(' ')}
                  onClick={() => close(it.value)}>
                  <span className="lbl">
                    {it.label}{it.detail ? <> <span className="desc">{it.detail}</span></> : null}
                    {it.sub ? <span className="sub">{it.sub}</span> : null}
                  </span>
                  {it.hint ? <Kbd>{it.hint}</Kbd> : it.note ? <span className="note">{it.note}</span> : null}
                </li>
              </Fragment>
            ))
          : <li className="desc">No matching results</li>}
        {matched.length > SHOWN
          ? (
            <li className="desc more">
              {(matched.length - SHOWN).toLocaleString('en-US')} more. Type to narrow the list.
            </li>
          )
          : null}
      </ul>
    </Dialog>
  );
}

function PromptDialog({ req }: { req: DeepReadonly<PromptRequest> }) {
  const [value, setValue] = useState('');
  const name = value.trim();
  const close = (v: string | null) => closePrompt(req, v);
  return (
    <Dialog open onOpenChange={(open) => { if (!open) close(null); }} title={req.placeholder}
      className={req.wide ? 'prompt wide' : 'prompt'}>
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
  return <AlertDialog title={title} body={body} confirmLabel={req.error ? 'Close' : req.ok ?? 'OK'}
    cancelLabel={req.cancel} altLabel={req.alt} error={req.error}
    copy={req.error ? () => copyText(withHint(title, body, req.hint), 'error') : undefined}
    onResult={(ok) => closeConfirm(req, ok)} onAlt={() => closeConfirm(req, 'alt')}>
    {req.hint ? <AiHint hint={req.hint} /> : null}
  </AlertDialog>;
}

function withHint(title: string, body: string | undefined, hint: DeepReadonly<ErrorHint> | undefined): string {
  const answer = hint?.state === 'done' ? `TL;DR: ${hint.tldr}\nFix: ${hint.fix}` : undefined;
  return answer ? [title, answer, body].filter(Boolean).join('\n\n') : [title, body].filter(Boolean).join('\n');
}

/** What the AI does while it reads, in order; the last stays until it answers. */
const PHRASES = ['Reading the log…', 'Finding what failed…', 'Tracing the cause…', 'Writing a fix…'];
const PHRASE_MS = 1600;

function Waiting() {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (n >= PHRASES.length - 1) return;
    const t = setTimeout(() => setN(n + 1), PHRASE_MS);
    return () => clearTimeout(t);
  }, [n]);
  return (
    <p className="ai-hint-busy">
      <Spinner />
      <span key={n} className="ai-hint-phrase" aria-hidden="true">{PHRASES[n]}</span>
      <span className="sr-only">The AI is reading the log</span>
    </p>
  );
}

/** A CLI that fails can leave its whole run as the reason, which ends with the error. */
const lastLine = (text: string): string => text.trim().split('\n').at(-1) ?? '';

function AiHint({ hint }: { hint: DeepReadonly<ErrorHint> }) {
  return (
    <div className="ai-hint" role="status" aria-busy={hint.state === 'busy'}>
      {hint.state === 'busy' ? <Waiting /> : null}
      <Reveal when={hint.state === 'done'}>
        {hint.state === 'done'
          ? <dl><dt>TL;DR</dt><dd>{hint.tldr}</dd><dt>Fix</dt><dd>{hint.fix}</dd></dl>
          : null}
      </Reveal>
      <Reveal when={hint.state === 'failed'}>
        {hint.state === 'failed' ? <p className="ai-hint-failed">No AI summary: {lastLine(hint.reason)}</p> : null}
      </Reveal>
    </div>
  );
}
