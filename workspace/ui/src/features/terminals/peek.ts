import type { IBufferCellPosition, ILink, ILinkProvider, Terminal } from '@xterm/xterm';
import { highlightLines } from '#editor/snippet';
import { errKind, errText, git } from '#ipc/git';
import { imageType, toPicture } from '#ipc/images';
import { toast } from '#kernel/dialogs';
import { epoch } from '#kernel/epoch';
import { baseName, within } from '#kernel/paths';
import { platform } from '#kernel/platform';
import { notify, S } from '#kernel/store';
import type { Anchor } from '#ui/HoverCard';
import { TIP_DELAY } from '#ui/Tip';
import type { PeekBody } from './state';

/** A path with an extension after a space, a quote, a bracket, `=` or `,`, then an optional `:line:col` or tsc's
 *  `(line,col)`, and nothing that would carry the name on. */
const PATH =
  /(^|[\s'"`([{<=,])(\/?(?:[\w.@+-]+\/)*\.?[\w@+-][\w.@+-]*\.[A-Za-z]\w*)(?::(\d+)(?::\d+)?|\((\d+),\d+\))?(?![\w/-])/g;
/** Each candidate costs a stat; a line of minified code or prose has many that name no file. */
const MAX_PER_LINE = 24;
/** A logical line wrapped over more rows than this is output, not something a path ends in. */
const MAX_ROWS = 40;
const AROUND = 3;
const HEAD = 10;
const MD = /\.(md|markdown|mdx)$/i;
const MD_MAX = 64 * 1024;
const KNOWN_MS = 5000;
const KNOWN_MAX = 1000;

type Logical = { text: string; at: IBufferCellPosition[] };

/** The logical line row `y` (0-based) is part of, with the 1-based cell each character of it came from. */
export function logicalLine(term: Terminal, y: number): Logical {
  const buf = term.buffer.active;
  let start = y;
  while (start > 0 && y - start < MAX_ROWS && buf.getLine(start)?.isWrapped) start--;
  let text = '';
  const at: IBufferCellPosition[] = [];
  const cell = buf.getNullCell();
  for (let row = start; row < start + MAX_ROWS; row++) {
    const line = buf.getLine(row);
    if (!line || (row > start && !line.isWrapped)) break;
    for (let x = 0; x < line.length; x++) {
      line.getCell(x, cell);
      // the second half of a wide character
      if (!cell.getWidth()) continue;
      const ch = cell.getChars() || ' ';
      for (let k = 0; k < ch.length; k++) at.push({ x: x + 1, y: row + 1 });
      text += ch;
    }
  }
  return { text, at };
}

function normalize(path: string): string | null {
  const out: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part !== '..') out.push(part);
    else if (out.pop() === undefined) return null;
  }
  return `/${out.join('/')}`;
}

const outside = (path: string): boolean => path.startsWith('/');

/** The files `raw` may name, relative to the repository when they are in it and absolute when not: from the
 *  terminal's folder first, then from the root, where an agent's paths start even after it changed folder. A folder
 *  outside the repository names its own files, not the root's. */
export function candidates(raw: string, cwd: string | null, root: string | null): string[] {
  const abs = (base: string | null): string | null => (base === null ? null : normalize(`${base}/${raw}`));
  const found = outside(raw) ? [normalize(raw)]
    : !root || (cwd && !within(cwd, root)) ? [abs(cwd)]
      : [abs(cwd), abs(root)].filter((p) => p && within(p, root));
  const out = new Set<string>();
  for (const p of found) {
    if (!p || p === root) continue;
    out.add(root && within(p, root) ? p.slice(root.length + 1) : p);
  }
  return [...out];
}

const known = new Map<string, { at: number; ok: Promise<boolean> }>();

/** A stat, through the image preview's: a file too large to read still exists, a folder does not count. */
function exists(root: string | null, rel: string): Promise<boolean> {
  const key = `${root ?? ''}\0${rel}`;
  const hit = known.get(key);
  if (hit && Date.now() - hit.at < KNOWN_MS) return hit.ok;
  if (known.size > KNOWN_MAX) known.clear();
  const stamp = outside(rel) ? git.peekStamp(rel) : git.imageStamp(null, rel);
  const ok = stamp.then((s) => s !== null, (e: unknown) => errKind(e) === 'TooLarge');
  known.set(key, { at: Date.now(), ok });
  return ok;
}

async function firstExisting(names: string[], root: string | null): Promise<string | null> {
  for (const rel of names) if (await exists(root, rel)) return rel;
  return null;
}

async function renderMarkdown(text: string): Promise<string> {
  const [{ marked }, { default: purify }] = await Promise.all([import('marked'), import('dompurify')]);
  const html = marked.parse(text.slice(0, MD_MAX), { async: false, gfm: true });
  // HTML alone: SVG could take the pointer back from the inert card, and its <image> loads what <img> may not
  return purify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: [
      'img', 'picture', 'video', 'audio', 'iframe', 'form', 'input', 'button', 'select', 'textarea', 'option', 'style',
    ],
    FORBID_ATTR: ['style', 'id', 'name', 'href'],
  });
}

/** The card places itself once, when it mounts, so the image's size has to be known before it renders. */
async function sizeOf(url: string): Promise<{ width: number; height: number } | null> {
  const img = new Image();
  img.src = url;
  try {
    await img.decode();
  } catch {
    return null;
  }
  return img.naturalWidth ? { width: img.naturalWidth, height: img.naturalHeight } : null;
}

async function load(path: string, line: number | null): Promise<PeekBody> {
  try {
    if (imageType(path)) {
      const p = await toPicture(await (outside(path) ? git.peekImage(path) : git.readImage(null, path)), path);
      if (!p.url) return { kind: 'note', text: 'Empty file' };
      return { kind: 'image', url: p.url, size: await sizeOf(p.url) };
    }
    const f = await (outside(path) ? git.peekText(path) : git.readFile(path));
    if (!f.exists) return { kind: 'note', text: 'The file is not there any more' };
    if (line === null && MD.test(path)) return { kind: 'markdown', html: await renderMarkdown(f.text) };
    const total = f.text.split('\n').length;
    const target = line === null ? null : Math.min(Math.max(1, line), total);
    const first = target === null ? 1 : Math.max(1, target - AROUND);
    const last = target === null ? HEAD : target + AROUND;
    return { kind: 'code', first, line: target, lines: await highlightLines(path, f.text, first, last) };
  } catch (e) {
    return { kind: 'note', text: errText(e) };
  }
}

const peeks = epoch();
let seq = 0;
const DISMISS = ['keydown', 'wheel', 'pointerdown'] as const;
/** xterm leaves a link and enters it again whenever it redraws the link's rows, which an agent's full-screen UI
 *  does many times a second; a leave closes the card only once this passes without the pointer coming back. */
const LEAVE_MS = 120;
/** The link the card is for, and the row it is on. */
let target: string | null = null;
let leaving: ReturnType<typeof setTimeout> | undefined;
/** A card that loaded while the pointer was leaving, shown if it comes back to the same link. */
let held: (() => void) | null = null;
/** The pointer is on the card, where a leave of its link, or a redraw under it, must not close it. */
let onCard = false;
/** A link the pointer crossed on its way from a card's link to the card, as the next row's path in a listing is:
 *  it replaces the card only if the pointer is still on it once the leave's grace is over. */
let crossing: (() => void) | null = null;
const MODIFIERS = new Set(['Meta', 'Control', 'Shift', 'Alt']);

function anchorOf(term: Terminal, e: MouseEvent): Anchor {
  const rect = term.element?.querySelector('.xterm-screen')?.getBoundingClientRect();
  if (!rect || !term.rows) return { x: e.clientX, top: e.clientY, bottom: e.clientY };
  const cell = rect.height / term.rows;
  const row = Math.floor((e.clientY - rect.top) / cell);
  return { x: e.clientX, top: rect.top + row * cell, bottom: rect.top + (row + 1) * cell };
}

function show(path: string, line: number | null, at: Anchor): void {
  const key = `${path}:${line ?? ''}@${at.top}`;
  if (key !== target && leaving !== undefined && S.termPeek) {
    crossing = () => show(path, line, at);
    return;
  }
  clearTimeout(leaving);
  leaving = undefined;
  crossing = null;
  if (key === target) {
    held?.();
    held = null;
    return;
  }
  hidePeek();
  target = key;
  // from the hover on, so a key pressed before the card shows still stops it
  for (const type of DISMISS) window.addEventListener(type, dismiss, true);
  const live = peeks.next();
  // the read waits too: a pointer on its way across a screen of paths would read every file it passes
  void new Promise((r) => setTimeout(r, TIP_DELAY.open)).then(async () => {
    if (!live()) return;
    const body = await load(path, line);
    if (!live()) return;
    const put = (): void => {
      S.termPeek = { id: ++seq, at, path, line, body };
      notify();
    };
    if (leaving === undefined) put();
    else held = put;
  });
}

function leave(): void {
  if (onCard) return;
  clearTimeout(leaving);
  // a link left again was only crossed
  crossing = null;
  leaving = setTimeout(() => {
    const next = crossing;
    hidePeek();
    next?.();
  }, LEAVE_MS);
}

/** The pointer reached the card from its link, inside the leave's grace. */
export function enterPeek(): void {
  onCard = true;
  clearTimeout(leaving);
  leaving = undefined;
  crossing = null;
}

/** `id` is the card's: one already on its way out can report its leave after a newer one opened. */
export function leavePeek(id: number): void {
  if (!onCard || S.termPeek?.id !== id) return;
  onCard = false;
  leave();
}

/** The card's own controls take the pointer without closing it. */
function dismiss(e: Event): void {
  // ⌘ alone is the start of the ⌘-click the card suggests
  if (e instanceof KeyboardEvent && MODIFIERS.has(e.key)) return;
  if (e.type !== 'keydown' && e.target instanceof Element && e.target.closest('.hovercard')) return;
  hidePeek();
}

/** In the app the system picks for the file; the card closes, since that app comes to the front. */
export async function openPeeked(path: string): Promise<void> {
  hidePeek();
  try {
    await git.openFile(path);
  } catch (e) {
    toast(`Could not open ${baseName(path)}: ${errText(e)}`, 'err');
  }
}

/** Cmd-click on macOS and Ctrl-click elsewhere, as a terminal opens a link: a plain click starts a selection. */
export const openClick = (e: MouseEvent): boolean => (platform() === 'macos' ? e.metaKey : e.ctrlKey);

export function hidePeek(): void {
  clearTimeout(leaving);
  leaving = undefined;
  target = null;
  held = null;
  onCard = false;
  crossing = null;
  peeks.bump();
  for (const type of DISMISS) window.removeEventListener(type, dismiss, true);
  if (!S.termPeek) return;
  S.termPeek = null;
  notify();
}

/** Links each path in session `id`'s output that names a file, and shows the file on hover. */
export function peekLinks(term: Terminal, id: number): ILinkProvider {
  let asked = 0;
  return {
    provideLinks(n, done) {
      const root = S.root;
      // xterm keeps only the newest row's replies, but files a late reply for an older row among them
      const mine = ++asked;
      const { text, at } = logicalLine(term, n - 1);
      const cwd = S.terminals.find((t) => t.id === id)?.cwd ?? null;
      const found = [...text.matchAll(PATH)].flatMap((m) => {
        const raw = m[2]!;
        const from = at[m.index + m[1]!.length];
        const to = at[m.index + m[0].length - 1];
        if (!from || !to || from.y > n || to.y < n) return [];
        const line = m[3] ?? m[4];
        return [{ raw, from, to, line: line ? Number(line) : null, label: m[0].slice(m[1]!.length) }];
      }).slice(0, MAX_PER_LINE);
      void Promise.all(found.map(async (f): Promise<ILink | null> => {
        const path = await firstExisting(candidates(f.raw, cwd, root), root);
        if (!path) return null;
        return {
          range: { start: f.from, end: f.to },
          text: f.label,
          decorations: { pointerCursor: false, underline: true },
          activate: (e) => { if (openClick(e)) void openPeeked(path); },
          hover: (e) => show(path, f.line, anchorOf(term, e)),
          leave,
        };
      })).then((links) => {
        if (mine !== asked) return;
        const real = links.filter((l): l is ILink => l !== null);
        done(real.length ? real : undefined);
      });
    },
  };
}
