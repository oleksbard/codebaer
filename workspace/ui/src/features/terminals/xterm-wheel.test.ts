import type { Terminal } from '@xterm/xterm';
import { afterEach, describe, expect, it } from 'vitest';
import { wheelHandler } from './xterm';

const CELL = 17;
const ROWS = 40;

type Mode = Terminal['modes']['mouseTrackingMode'];

/** The slice of an xterm Terminal the handler reads, over a DOM shaped like the one xterm builds. */
function setup(mouseTrackingMode: Mode, type: 'normal' | 'alternate' = 'normal') {
  const element = document.createElement('div');
  const screen = document.createElement('div');
  screen.className = 'xterm-screen';
  Object.defineProperty(screen, 'offsetHeight', { value: CELL * ROWS });
  element.append(screen);
  document.body.append(element);
  const handler = wheelHandler({ modes: { mouseTrackingMode }, buffer: { active: { type } }, rows: ROWS, element });
  // stands in for xterm's own listener: it runs the custom handler and acts only on a true
  const processed: WheelEvent[] = [];
  element.addEventListener('wheel', (e) => {
    if (handler(e)) processed.push(e);
  });
  const wheel = (deltaY: number, init: WheelEventInit = {}): WheelEvent => {
    const e = new WheelEvent('wheel', { deltaY, clientX: 30, clientY: 40, bubbles: true, cancelable: true, ...init });
    // the DOM renderer's rows take no pointer events, so the wheel lands on the screen itself
    screen.dispatchEvent(e);
    return e;
  };
  return { processed, wheel };
}

afterEach(() => document.body.replaceChildren());

describe('a program that reads the wheel gets one line per cell height of travel', () => {
  it('turns small trackpad deltas into whole lines at the pointer', () => {
    const { processed, wheel } = setup('any');
    const sent = Array.from({ length: 7 }, () => wheel(5));

    expect(processed).toHaveLength(2);
    for (const e of processed) {
      expect(e.deltaMode).toBe(WheelEvent.DOM_DELTA_LINE);
      expect(e.deltaY).toBe(1);
      expect([e.clientX, e.clientY]).toEqual([30, 40]);
    }
    expect(sent.every((e) => e.defaultPrevented)).toBe(true);
  });

  it('sends several lines for one large delta and keeps the remainder', () => {
    const { processed, wheel } = setup('vt200');
    wheel(-60);
    expect(processed.map((e) => e.deltaY)).toEqual([-1, -1, -1]);
    wheel(-9);
    expect(processed).toHaveLength(4);
  });

  it('starts over when the direction reverses', () => {
    const { processed, wheel } = setup('drag');
    wheel(16);
    wheel(-10);
    wheel(-10);
    expect(processed.map((e) => e.deltaY)).toEqual([-1]);
  });

  it('counts line-mode deltas in lines', () => {
    const { processed, wheel } = setup('any');
    wheel(3, { deltaMode: WheelEvent.DOM_DELTA_LINE });
    expect(processed.map((e) => e.deltaY)).toEqual([1, 1, 1]);
  });

  it('counts a page-mode delta as a screenful of lines', () => {
    const { processed, wheel } = setup('any');
    wheel(-1, { deltaMode: WheelEvent.DOM_DELTA_PAGE });
    expect(processed).toHaveLength(ROWS);
    expect(processed.every((e) => e.deltaY === -1)).toBe(true);
  });

  it('covers the alternate screen, where xterm sends arrow keys instead of reports', () => {
    const { processed, wheel } = setup('none', 'alternate');
    wheel(40);
    expect(processed.map((e) => e.deltaY)).toEqual([1, 1]);
  });

  it('keeps a separate remainder for each terminal', () => {
    const a = setup('any');
    const b = setup('any');
    a.wheel(10);
    b.wheel(10);
    expect([...a.processed, ...b.processed]).toEqual([]);
  });

  it('keeps modifiers, which a mouse report carries', () => {
    const { processed, wheel } = setup('any');
    wheel(CELL, { ctrlKey: true, altKey: true });
    expect(processed[0]).toMatchObject({ ctrlKey: true, altKey: true });
  });
});

describe('everything else stays with xterm', () => {
  it.each<Mode>(['none', 'x10'])('scrollback scrolls itself with mouse tracking %s', (mode) => {
    const { processed, wheel } = setup(mode);
    const e = wheel(5);
    expect(processed).toEqual([e]);
  });

  it('passes shift and horizontal-only events through', () => {
    const { processed, wheel } = setup('any');
    const shifted = wheel(40, { shiftKey: true });
    const sideways = wheel(0, { deltaX: 30 });
    expect(processed).toEqual([shifted, sideways]);
  });
});
