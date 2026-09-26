import { platform } from './platform';

export type Binding<Id extends string = string> = {
  /** 'Mod+Shift+Y', 'F7', 'Alt+Shift+F5', or a chord of two strokes, 'Mod+K Mod+Alt+S'. Mod is Cmd on macOS. */
  keys: string;
  command: Id;
  /** Where focus may be; the default 'app' is anywhere but a terminal. */
  in?: 'app' | 'terminal' | 'any';
  notIn?: readonly 'comment'[];
  /** Runs without preventDefault or stopPropagation, so the key still reaches whatever has focus. */
  passThrough?: boolean;
  /** Handled by a component through matches(), or by the native menu; listed for labels. The global
   *  handler skips it. */
  local?: boolean;
};

type KeyLike = Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>;
type Stroke = {
  meta: boolean; ctrl: boolean; alt: boolean; shift: boolean; code: string | null; key: string; label: string;
};
type Row = Binding & { strokes: Stroke[] };

const CODES: Record<string, string> = { '[': 'BracketLeft', ']': 'BracketRight', ',': 'Comma' };
const NAMES: Record<string, string> = { Enter: '↩' };

function stroke(text: string): Stroke {
  const parts = text.split('+');
  const key = parts.at(-1) ?? '';
  const mods = new Set(parts.slice(0, -1));
  const mac = platform() === 'macos';
  const meta = mods.has('Meta') || (mac && mods.has('Mod'));
  const ctrl = mods.has('Ctrl') || (!mac && mods.has('Mod'));
  const alt = mods.has('Alt');
  const shift = mods.has('Shift');
  // letters, digits and punctuation by their physical key, so a layout or Option does not change them;
  // F-keys, Enter and Escape by name
  const code = /^[A-Z]$/.test(key) ? `Key${key}` : /^\d$/.test(key) ? `Digit${key}` : CODES[key] ?? null;
  const label = `${meta ? '⌘' : ''}${ctrl ? '⌃' : ''}${alt ? '⌥' : ''}${shift ? '⇧' : ''}${NAMES[key] ?? key}`;
  return { meta, ctrl, alt, shift, code, key, label };
}

const hits = (e: KeyLike, s: Stroke): boolean =>
  e.metaKey === s.meta && e.ctrlKey === s.ctrl && e.altKey === s.alt && e.shiftKey === s.shift
  && (s.code === null ? e.key === s.key : e.code === s.code);

const same = (a: Stroke, b: Stroke): boolean => a.label === b.label;

let rows: readonly Row[] = [];

/** The table the key handler, the labels and matches() read. */
export function setKeymap(table: readonly Binding[]): void {
  rows = table.map((b) => ({ ...b, strokes: b.keys.split(' ').map(stroke) }));
}

type Focus = { terminal: boolean; comment: boolean };

function focusOf(e: Event): Focus {
  // the event target inside a terminal is xterm's hidden textarea, not the host element
  const el = e.target instanceof Element ? e.target : null;
  return { terminal: !!el?.closest('.term-host'), comment: !!el?.closest('.comment-box') };
}

function allowed(r: Row, f: Focus): boolean {
  const scope = r.in ?? 'app';
  if (scope !== 'any' && (scope === 'terminal') !== f.terminal) return false;
  return !(f.comment && r.notIn?.includes('comment'));
}

export function installKeys(
  run: (command: string) => void,
  onChord: (visible: boolean) => void = () => {},
): () => void {
  let pending: Stroke | null = null;
  let until = 0;
  const fire = (e: KeyboardEvent, r: Row) => {
    if (!r.passThrough) {
      e.preventDefault();
      e.stopPropagation();
    }
    run(r.command);
  };
  const onKey = (e: KeyboardEvent) => {
    const f = focusOf(e);
    const global = rows.filter((r) => !r.local);
    if (pending && Date.now() < until && !f.terminal) {
      const prefix = pending;
      pending = null;
      until = 0;
      onChord(false);
      const hit = global.find((r) => r.strokes.length === 2 && same(r.strokes[0]!, prefix)
        && hits(e, r.strokes[1]!) && allowed(r, f));
      if (hit) fire(e, hit);
      return;
    }
    const single = global.filter((r) => r.strokes.length === 1 && hits(e, r.strokes[0]!));
    if (single.length) {
      // a key the focused place owns reaches it untouched
      const hit = single.find((r) => allowed(r, f));
      if (hit) fire(e, hit);
      return;
    }
    const chord = global.find((r) => r.strokes.length === 2 && hits(e, r.strokes[0]!) && allowed(r, f));
    if (!chord) return;
    pending = chord.strokes[0]!;
    until = Date.now() + 2500;
    onChord(true);
    setTimeout(() => { if (Date.now() >= until) onChord(false); }, 2600);
    e.preventDefault();
  };
  document.addEventListener('keydown', onKey, true);
  return () => document.removeEventListener('keydown', onKey, true);
}

const labelOf = (r: Row): string => r.strokes.map((s) => s.label).join(' ');

/** A command bound twice shows the binding that fits where the label is: the first or the last row. */
export function keyLabel(command: string, which: 'first' | 'last' = 'first'): string {
  const mine = rows.filter((r) => r.command === command);
  const r = which === 'first' ? mine[0] : mine.at(-1);
  return r ? labelOf(r) : '';
}

/** The palette's hint: only a binding that works wherever the palette was opened from. */
export function hintFor(command: string): string {
  const r = rows.find((x) => x.command === command && !x.local);
  return r ? labelOf(r) : '';
}

/** For a component's own key handler: the event is one of `command`'s single-stroke bindings. */
export const matches = (e: KeyLike, command: string): boolean =>
  rows.some((r) => r.command === command && r.strokes.length === 1 && hits(e, r.strokes[0]!));

/** Every chord, as the labels of its two strokes, for the hint shown while one is pending. */
export const chords = (): { prefix: string; next: string; command: string }[] =>
  rows.filter((r) => r.strokes.length === 2)
    .map((r) => ({ prefix: r.strokes[0]!.label, next: r.strokes[1]!.label, command: r.command }));
