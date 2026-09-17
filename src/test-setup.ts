// jsdom implements no Range geometry, and CodeMirror measures the document
// whenever a dispatch asks to scroll a chunk into view
const rangeProto = Range.prototype as unknown as Record<string, unknown>;
rangeProto.getClientRects = () => [];
rangeProto.getBoundingClientRect = () => new DOMRect();

// jsdom has PointerEvent but no pointer capture, no scrollIntoView, no ResizeObserver;
// the gutter, the palette list, and Radix ask for them
HTMLElement.prototype.setPointerCapture ??= () => {};
HTMLElement.prototype.hasPointerCapture ??= () => false;
HTMLElement.prototype.releasePointerCapture ??= () => {};
Element.prototype.scrollIntoView ??= () => {};
globalThis.ResizeObserver ??= class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
} as unknown as typeof ResizeObserver;

/** React flushes store-driven renders in a microtask; one macrotask covers it. */
export const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/**
 * React's value tracker swallows an `input` event whose value was set through the
 * element's own setter, so a test sets the value through the prototype setter first.
 */
export function setValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
