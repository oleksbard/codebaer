import { afterEach, describe, expect, it } from 'vitest';
import type { ReactElement } from 'react';
import { MotionGlobalConfig } from 'motion/react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { setMotion } from '#ui/motion';
import { exitTick } from '#test-setup';
import { Count } from './Count';

/** `full`, so `Count` takes its `AnimatePresence` branch, with Motion's own animations skipped so an exit
 *  removes its node at once instead of lingering with no real frames to drive it. */
function fullNoAnimate(): void {
  setMotion('full');
  MotionGlobalConfig.skipAnimations = true;
}

let root: Root | null = null;
let host: HTMLElement | null = null;

function render(el: ReactElement): HTMLElement {
  if (!root) {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  }
  flushSync(() => root!.render(el));
  return host!;
}

afterEach(() => {
  root?.unmount();
  root = null;
  host?.remove();
  host = null;
  setMotion('off');
});

describe('Count', () => {
  it('shows plain text, with no child element, under lite and off', () => {
    setMotion('lite');
    const el = render(<Count value={3} />);
    expect(el.textContent).toBe('3');
    expect(el.querySelector('.count')!.children.length).toBe(0);
  });

  it('shows the formatted text under full motion too', () => {
    fullNoAnimate();
    const el = render(<Count value={3} format={(n) => `+${n}`} />);
    expect(el.textContent).toBe('+3');
  });

  it('updates the shown text as the value changes, under full motion', async () => {
    fullNoAnimate();
    let el = render(<Count value={3} />);
    expect(el.textContent).toBe('3');
    el = render(<Count value={4} />);
    await exitTick();
    expect(el.textContent).toBe('4');
    el = render(<Count value={2} />);
    await exitTick();
    expect(el.textContent).toBe('2');
  });

  it('keys by the shown text, not the raw value: a change that does not move the text (the "99+" cap) '
    + 'does not remount the node', async () => {
    fullNoAnimate();
    const format = (n: number) => (n > 99 ? '99+' : String(n));
    let el = render(<Count value={100} format={format} />);
    expect(el.textContent).toBe('99+');
    const before = el.querySelector('.count > *');
    el = render(<Count value={101} format={format} />);
    await exitTick();
    expect(el.textContent).toBe('99+');
    expect(el.querySelector('.count > *')).toBe(before);
  });

  it('remounts the node when the shown text does change', async () => {
    fullNoAnimate();
    let el = render(<Count value={1} />);
    const before = el.querySelector('.count > *');
    el = render(<Count value={2} />);
    await exitTick();
    expect(el.querySelector('.count > *')).not.toBe(before);
  });
});
