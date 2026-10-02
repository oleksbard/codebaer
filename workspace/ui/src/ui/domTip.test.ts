import { afterEach, describe, expect, it, vi } from 'vitest';
import { tick } from '#test-setup';
import { attachTip } from './domTip';

const tips = () => [...document.querySelectorAll<HTMLElement>('.tip')];
const fire = (el: Element, type: string) => el.dispatchEvent(new PointerEvent(type, { bubbles: true }));

function target(rect: Partial<DOMRect>): HTMLButtonElement {
  const el = document.createElement('button');
  document.body.append(el);
  el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0, ...rect }) as DOMRect;
  return el;
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('attachTip', () => {
  it('shows the label in a tip under the element after the delay, and removes it when the pointer leaves', async () => {
    const el = target({ left: 100, top: 50, width: 40, height: 20, bottom: 70 });
    attachTip(el, 'Expand 4 hidden lines');
    expect(tips()).toHaveLength(0);
    fire(el, 'pointerenter');
    await tick();
    const [tip] = tips();
    expect(tip?.textContent).toBe('Expand 4 hidden lines');
    expect(tip?.getAttribute('data-state')).toBe('delayed-open');
    expect(tip?.className).toBe('tip tip-s');
    expect(tip?.style.top).toBe('76px');
    fire(el, 'pointerleave');
    expect(tips()).toHaveLength(0);
  });

  it('shows nothing when the pointer leaves before the delay', async () => {
    const el = target({});
    attachTip(el, 'x');
    fire(el, 'pointerenter');
    fire(el, 'pointerleave');
    await tick();
    expect(tips()).toHaveLength(0);
  });

  it('goes away on a press, a key and a scroll, and leaves no listener behind', async () => {
    const remove = vi.spyOn(window, 'removeEventListener');
    const el = target({});
    attachTip(el, 'x');
    for (const gone of [() => fire(el, 'pointerdown'), () => window.dispatchEvent(new KeyboardEvent('keydown')),
      () => document.dispatchEvent(new Event('scroll'))]) {
      fire(el, 'pointerenter');
      await tick();
      expect(tips()).toHaveLength(1);
      gone();
      expect(tips()).toHaveLength(0);
    }
    expect(remove.mock.calls.map((c) => c[0]).filter((t) => t === 'keydown')).toHaveLength(3);
    window.dispatchEvent(new KeyboardEvent('keydown'));
    expect(tips()).toHaveLength(0);
  });

  it('opens above when there is no room below, and stays inside the viewport', async () => {
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(200);
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(30);
    const el = target({ left: 2, top: window.innerHeight - 20, width: 10, height: 20, bottom: window.innerHeight });
    attachTip(el, 'x');
    fire(el, 'pointerenter');
    await tick();
    const tip = tips()[0]!;
    expect(tip.style.top).toBe(`${window.innerHeight - 20 - 6 - 30}px`);
    expect(tip.style.left).toBe('8px');
  });

  it('is removed with an element that left the page while it showed', async () => {
    const el = target({});
    attachTip(el, 'x');
    fire(el, 'pointerenter');
    await tick();
    el.remove();
    window.dispatchEvent(new PointerEvent('pointermove'));
    expect(tips()).toHaveLength(0);
  });
});
