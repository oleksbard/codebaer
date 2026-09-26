import { ClipboardAddon } from '@xterm/addon-clipboard';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { UnicodeGraphemesAddon } from '@xterm/addon-unicode-graphemes';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal, type ITheme } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { input, inputBytes, resize, restore, subscribe as attach, type ServerMsg } from '#ipc/terminal';

export type Term = {
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  el: HTMLDivElement;
};

const FONT_KEY = 'codebaer.term.fontSize';
const SCROLL_KEY = 'codebaer.term.scrollback';
const terms = new Map<number, Term>();

export const fontSize = (): number => Number(localStorage.getItem(FONT_KEY)) || 13;
const scrollback = (): number => Number(localStorage.getItem(SCROLL_KEY)) || 5000;

// xterm parses theme colours itself and does not understand oklch, so the browser converts
// each token by painting it: the canvas is the only parser guaranteed to agree with the page
const probe = document.createElement('canvas').getContext('2d', { willReadFrequently: true });

function hex(css: string): string {
  if (!probe || !css) return '#000000';
  probe.clearRect(0, 0, 1, 1);
  probe.fillStyle = '#000000';
  probe.fillStyle = css;
  probe.fillRect(0, 0, 1, 1);
  const px = probe.getImageData(0, 0, 1, 1).data;
  const to = (i: number) => (px[i] ?? 0).toString(16).padStart(2, '0');
  return px[3] === 255 ? `#${to(0)}${to(1)}${to(2)}` : `#${to(0)}${to(1)}${to(2)}${to(3)}`;
}

const token = (name: string): string =>
  hex(getComputedStyle(document.documentElement).getPropertyValue(name).trim());

function theme(): ITheme {
  return {
    background: token('--bg'),
    foreground: token('--text'),
    cursor: token('--accent'),
    cursorAccent: token('--bg'),
    selectionBackground: token('--accent-soft'),
    black: token('--ansi-black'),
    red: token('--ansi-red'),
    green: token('--ansi-green'),
    yellow: token('--ansi-yellow'),
    blue: token('--ansi-blue'),
    magenta: token('--ansi-magenta'),
    cyan: token('--ansi-cyan'),
    white: token('--ansi-white'),
    brightBlack: token('--ansi-bright-black'),
    brightRed: token('--ansi-bright-red'),
    brightGreen: token('--ansi-bright-green'),
    brightYellow: token('--ansi-bright-yellow'),
    brightBlue: token('--ansi-bright-blue'),
    brightMagenta: token('--ansi-bright-magenta'),
    brightCyan: token('--ansi-bright-cyan'),
    brightWhite: token('--ansi-bright-white'),
  };
}

/** Re-resolves every token, for the same reason `editor-theme` reads tokens: one theme switch. */
export function retheme(): void {
  for (const t of terms.values()) t.term.options.theme = theme();
}

type WheelTerm = {
  readonly modes: { readonly mouseTrackingMode: Terminal['modes']['mouseTrackingMode'] };
  readonly buffer: { readonly active: { readonly type: 'normal' | 'alternate' } };
  readonly rows: number;
  readonly element: HTMLElement | undefined;
};

/** x10 tracking reports button presses only, so the wheel stays with the scrollback. */
const WHEEL_REPORTING = new Set<WheelTerm['modes']['mouseTrackingMode']>(['vt200', 'drag', 'any']);

/**
 * xterm 6 sends a program that reads the wheel (Claude Code's fullscreen UI, vim, less) at most one
 * line per wheel event, and counts a trackpad's travel as 0.3 of the lines it covers, so a swipe there
 * moves about a third of what it scrolls anywhere else. This replays one line-sized event per cell
 * height of travel instead, and xterm encodes each for the active mouse protocol as it would its own.
 */
export function wheelHandler(term: WheelTerm): (e: WheelEvent) => boolean {
  let px = 0;
  let replaying = false;
  return (e) => {
    const toApp = WHEEL_REPORTING.has(term.modes.mouseTrackingMode) || term.buffer.active.type === 'alternate';
    if (replaying || !toApp || e.shiftKey || !e.deltaY || !e.target) return true;
    const screen = term.element?.querySelector<HTMLElement>('.xterm-screen');
    const cell = screen && term.rows ? screen.offsetHeight / term.rows : 0;
    if (!cell) return true;
    const delta = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? e.deltaY * cell
      : e.deltaMode === WheelEvent.DOM_DELTA_PAGE ? e.deltaY * cell * term.rows
      : e.deltaY;
    // a reversal answers at once instead of first paying back what the other direction left over
    if (Math.sign(delta) !== Math.sign(px)) px = 0;
    px += delta;
    const lines = Math.trunc(px / cell);
    px -= lines * cell;
    // xterm cancels a wheel it reports, but not one it would have turned into arrow keys
    e.preventDefault();
    replaying = true;
    try {
      for (let i = 0; i < Math.abs(lines); i++) {
        e.target.dispatchEvent(new WheelEvent('wheel', {
          deltaY: Math.sign(lines),
          deltaMode: WheelEvent.DOM_DELTA_LINE,
          clientX: e.clientX,
          clientY: e.clientY,
          ctrlKey: e.ctrlKey,
          altKey: e.altKey,
          metaKey: e.metaKey,
          bubbles: true,
          cancelable: true,
        }));
      }
    } finally {
      replaying = false;
    }
    return false;
  };
}

function create(id: number, el: HTMLDivElement): Term {
  const term = new Terminal({
    allowProposedApi: true,
    fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--mono').trim() || 'monospace',
    fontSize: fontSize(),
    scrollback: scrollback(),
    theme: theme(),
    cursorBlink: true,
    macOptionIsMeta: true,
  });
  const fit = new FitAddon();
  const search = new SearchAddon();
  term.loadAddon(fit);
  term.loadAddon(search);
  term.loadAddon(new WebLinksAddon());
  term.loadAddon(new ClipboardAddon());
  const graphemes = new UnicodeGraphemesAddon();
  term.loadAddon(graphemes);
  try {
    term.unicode.activeVersion = '15';
  } catch {
    // the addon registers the table; an older xterm without it keeps its built-in widths
  }
  // no renderer addon, so xterm's DOM renderer draws, and a session kept alive off screen holds no
  // viewport-sized canvases. The webgl addon has an open corruption bug reproduced under Tauri on
  // macOS, and xterm 6 dropped the canvas addon.
  term.open(el);
  // the agent CLIs read ESC CR as "insert a newline"; xterm sends a bare CR for shift-enter,
  // which they read as submit. This is what a terminal's own Claude Code setup binds.
  term.attachCustomKeyEventHandler((e) => {
    // already acted on by a dialog around the terminal: Radix closes one on Escape in the capture phase
    if (e.defaultPrevented) return false;
    if (e.type !== 'keydown' || e.key !== 'Enter' || e.isComposing) return true;
    if (!e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return true;
    // refusing the event returns before xterm's own cancel(), and an Enter whose default still
    // runs produces a keypress that sends the bare CR this exists to replace
    e.preventDefault();
    void input(id, '\x1b\r');
    return false;
  });
  term.attachCustomWheelEventHandler(wheelHandler(term));
  term.onData((data) => void input(id, data));
  // legacy X10 and 1005 mouse reports are not UTF-8 and arrive here instead of onData
  term.onBinary((data) => {
    const bytes = Array.from(data, (ch) => ch.charCodeAt(0) & 0xff);
    void inputBytes(id, bytes);
  });
  term.onResize(({ cols, rows }) => void resize(id, cols, rows));
  const t = { term, fit, search, el };
  terms.set(id, t);
  return t;
}

/** Instances outlive a switch, so scroll position and selection survive it. */
export function mount(id: number, host: HTMLElement): Term {
  let t = terms.get(id);
  if (!t) {
    const el = document.createElement('div');
    el.className = 'term';
    host.replaceChildren(el);
    t = create(id, el);
  } else if (t.el.parentElement !== host) {
    host.replaceChildren(t.el);
  }
  fit(id);
  // whatever arrived for this session before it had an instance, including its whole replay
  flush();
  return t;
}

export function fit(id: number): void {
  const t = terms.get(id);
  if (!t || !t.el.isConnected || !t.el.clientWidth) return;
  try {
    t.fit.fit();
  } catch {
    // fit measures the DOM; a host that is hidden or zero-sized has nothing to measure yet
  }
}

export function focus(id: number): void {
  terms.get(id)?.term.focus();
}

export function dispose(id: number): void {
  const t = terms.get(id);
  if (!t) return;
  t.term.dispose();
  t.el.remove();
  terms.delete(id);
  lastOut.delete(id);
}

// ponytail: output is the only tell a Command session gives. An agent repaints its spinner while
// it thinks and is silent at its prompt; a shell running `top` reads as busy, which is honest.
const BUSY_MS = 700;
const TICK = 300;
const REPLAY_MS = 1500;
const lastOut = new Map<number, number>();
let sweep: ReturnType<typeof setInterval> | null = null;
let busySet = '';
let onBusyChange: (() => void) | null = null;
/** Attaching replays every session's ring at once, which is not a session doing work. */
let replayUntil = 0;

export const working = (id: number): boolean => Date.now() - (lastOut.get(id) ?? -Infinity) < BUSY_MS;

/** Called when a session starts or stops producing output; nothing runs while every session is quiet. */
export function watchOutput(fn: () => void): void {
  onBusyChange = fn;
}

function sweepBusy(): void {
  const now = [...lastOut.keys()].filter(working).join();
  if (now !== busySet) {
    busySet = now;
    onBusyChange?.();
  }
  if (!now && sweep) {
    clearInterval(sweep);
    sweep = null;
  }
}

export function setFontSize(px: number): void {
  const size = Math.max(9, Math.min(24, px));
  localStorage.setItem(FONT_KEY, String(size));
  for (const [id, t] of terms) {
    t.term.options.fontSize = size;
    fit(id);
  }
}

export function find(id: number, query: string, back = false): void {
  const t = terms.get(id);
  if (!t) return;
  if (back) t.search.findPrevious(query);
  else t.search.findNext(query);
}

export function clear(id: number): void {
  terms.get(id)?.term.clear();
}

type Pending = { chunks: Uint8Array[]; size: number };
const pending = new Map<number, Pending>();
/// Past this a session nobody has mounted is holding more than the host's own ring, so the
/// oldest chunks are older scrollback than a fresh replay would give it.
const MAX_PENDING = 8 * 1024 * 1024;
let frame = 0;

/** One `write` per session per animation frame: a fast producer can otherwise reach xterm's
 *  own 50 MB write-buffer guard, and a human cannot see the difference either way. */
function write(id: number, bytes: Uint8Array): void {
  let queued = pending.get(id);
  if (!queued) {
    queued = { chunks: [], size: 0 };
    pending.set(id, queued);
  }
  queued.chunks.push(bytes);
  queued.size += bytes.length;
  while (queued.size > MAX_PENDING && queued.chunks.length > 1) {
    queued.size -= queued.chunks.shift()!.length;
  }
  if (Date.now() >= replayUntil) {
    lastOut.set(id, Date.now());
    sweep ??= setInterval(sweepBusy, TICK);
  }
  if (!frame) frame = requestAnimationFrame(flush);
}

function flush(): void {
  frame = 0;
  for (const [id, queued] of pending) {
    const t = terms.get(id);
    // kept, not dropped: only the active session is mounted, so an Attach replay for every
    // other one arrives before it has anywhere to go. mount() drains it.
    if (!t) continue;
    const all = new Uint8Array(queued.size);
    let at = 0;
    for (const c of queued.chunks) {
      all.set(c, at);
      at += c.length;
    }
    t.term.write(all);
    pending.delete(id);
  }
}

/** Drops everything held for a session, so that a replay of its ring starts from nothing. The
 *  instance is cleared rather than disposed, since the view may be showing it already, and by a
 *  written RIS rather than `reset()`, which would leave what xterm has queued to parse after it. */
export function reset(id: number): void {
  pending.delete(id);
  terms.get(id)?.term.write('\x1bc');
}

/** The payload is a little-endian session id followed by raw pty bytes. */
export function route(message: ArrayBuffer | number[]): void {
  const buf = message instanceof ArrayBuffer ? message : new Uint8Array(message).buffer;
  if (buf.byteLength < 4) return;
  const id = new DataView(buf).getUint32(0, true);
  write(id, new Uint8Array(buf, 4));
}

/** Called on every mount: a reload destroys these channels without telling Rust, and
 *  re-subscribing is what makes the host replay each ring into a fresh instance. */
export function subscribe(onEvent: (m: ServerMsg) => void): Promise<void> {
  replayUntil = Date.now() + REPLAY_MS;
  return attach(route, onEvent);
}

export function restoreOrphan(sock: string, id: number | null, pid: number): Promise<void> {
  const [cols, rows] = size();
  return restore(sock, id, pid, cols, rows);
}

/** The geometry of any live instance, so a new session opens at the size it will be shown at
 *  rather than at 80x24 followed by a reflow. */
export function size(): [number, number] {
  for (const t of terms.values()) if (t.term.cols > 2) return [t.term.cols, t.term.rows];
  return [80, 24];
}
