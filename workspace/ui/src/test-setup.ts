import { vi } from 'vitest';
import './app/state';
import './app/keymap';
import { setMotion } from './ui/motion';

setMotion('off');

// @xterm/addon-unicode-graphemes 0.4.0 decodes its width table with Buffer when Buffer exists, then reads the
// table's header through a DataView over the whole Buffer pool, not over the table. In Node the header then comes
// from whatever else the pool holds, and the import can throw "Data error". WKWebView has no Buffer.
vi.mock('@xterm/addon-unicode-graphemes', () => ({
  UnicodeGraphemesAddon: class {
    activate(): void {}
    dispose(): void {}
  },
}));

// jsdom implements no Range geometry, and CodeMirror measures the document
// whenever a dispatch asks to scroll a chunk into view
const rangeProto = Range.prototype as unknown as Record<string, unknown>;
rangeProto.getClientRects = () => [];
rangeProto.getBoundingClientRect = () => new DOMRect();

// jsdom's own canvas logs that it is not implemented on each call; the glow draws without a context
HTMLCanvasElement.prototype.getContext = () => null;

// jsdom has PointerEvent but no pointer capture, no scrollIntoView, no ResizeObserver;
// the gutter, the palette list, and Radix ask for them
HTMLElement.prototype.setPointerCapture ??= () => {};
HTMLElement.prototype.hasPointerCapture ??= () => false;
HTMLElement.prototype.releasePointerCapture ??= () => {};
Element.prototype.scrollIntoView ??= () => {};
// nor the Web Animations API. The hunk ghost calls it directly and awaits `finished`; Motion detects
// WAAPI support from `Element.prototype.animate` alone and then drives its own completion off `onfinish`,
// so the stub has to call that too, or an AnimatePresence exit never resolves and its node never unmounts.
Element.prototype.animate ??= function animate(this: Element): Animation {
  const anim = {
    currentTime: 0,
    startTime: 0,
    playbackRate: 1,
    playState: 'finished',
    finished: Promise.resolve(),
    onfinish: null as (() => void) | null,
    oncancel: null,
    play() {},
    pause() {},
    finish() { anim.onfinish?.(); },
    cancel() {},
    commitStyles() {},
    updatePlaybackRate() {},
    persist() {},
    addEventListener() {},
    removeEventListener() {},
  };
  queueMicrotask(() => anim.onfinish?.());
  return anim as unknown as Animation;
} as unknown as typeof Element.prototype.animate;
globalThis.ResizeObserver ??= class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
} as unknown as typeof ResizeObserver;

// nor matchMedia, which the terminal rail asks for its reduced-motion check. It has to carry the
// listener methods too: CodeMirror tests for matchMedia and then subscribes to the one it gets back.
globalThis.matchMedia ??= ((media: string) => ({
  media,
  matches: false,
  onchange: null,
  addEventListener: () => {},
  removeEventListener: () => {},
  addListener: () => {},
  removeListener: () => {},
  dispatchEvent: () => false,
})) as unknown as typeof matchMedia;

/** React flushes store-driven renders in a microtask; one macrotask covers it. */
export const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** An `AnimatePresence` exit needs two real animation frames to remove its node, even under
 *  `MotionGlobalConfig.skipAnimations`: one for the motion value to settle at its final keyframe, another for
 *  React to commit the unmount `safeToRemove` triggers. `tick` (a macrotask) is not enough. */
export const exitTick = (): Promise<void> =>
  new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

/**
 * React's value tracker swallows an `input` event whose value was set through the
 * element's own setter, so a test sets the value through the prototype setter first.
 */
export function setValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
