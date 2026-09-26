import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { chords, hintFor, installKeys, keyLabel, matches, setKeymap } from './keymap';

const ran: string[] = [];
const hint: boolean[] = [];

beforeAll(() => {
  setKeymap([
    { keys: 'Mod+Y', command: 'yes' },
    { keys: 'F7', command: 'next' },
    { keys: 'Mod+T', command: 'term', in: 'any' },
    { keys: 'Escape', command: 'esc', notIn: ['comment'], passThrough: true },
    { keys: 'Mod+K Mod+R', command: 'chorded' },
    { keys: 'Mod+Enter', command: 'box', local: true },
    { keys: 'Mod+Shift+Y', command: 'yes' },
  ]);
  installKeys((c) => { ran.push(c); }, (v) => { hint.push(v); });
});

afterEach(() => {
  ran.length = 0;
  hint.length = 0;
  document.body.replaceChildren();
});

type Init = { key: string; code: string; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean; ctrlKey?: boolean };
const ev = (init: Init): KeyboardEvent => new KeyboardEvent('keydown', {
  key: init.key, code: init.code, metaKey: !!init.metaKey, altKey: !!init.altKey, shiftKey: !!init.shiftKey,
  ctrlKey: !!init.ctrlKey, bubbles: true, cancelable: true,
});
function press(init: Init, where?: string): KeyboardEvent {
  let el: Element = document.body;
  if (where) {
    const host = document.body.appendChild(document.createElement('div'));
    host.className = where;
    el = host.appendChild(document.createElement('textarea'));
  }
  const e = ev(init);
  el.dispatchEvent(e);
  return e;
}

describe('the keymap engine', () => {
  it('matches modifiers exactly', () => {
    press({ key: 'y', code: 'KeyY', metaKey: true });
    press({ key: 'y', code: 'KeyY', metaKey: true, shiftKey: true });
    press({ key: 'y', code: 'KeyY', metaKey: true, altKey: true });
    press({ key: 'F7', code: 'F7', metaKey: true });
    expect(ran).toEqual(['yes', 'yes']);
  });

  it('leaves a key the terminal owns alone, and runs one bound everywhere', () => {
    expect(press({ key: 'y', code: 'KeyY', metaKey: true }, 'term-host').defaultPrevented).toBe(false);
    expect(press({ key: 't', code: 'KeyT', metaKey: true }, 'term-host').defaultPrevented).toBe(true);
    expect(ran).toEqual(['term']);
  });

  it('passes Escape through, and leaves it to a comment box', () => {
    expect(press({ key: 'Escape', code: 'Escape' }).defaultPrevented).toBe(false);
    press({ key: 'Escape', code: 'Escape' }, 'comment-box');
    expect(ran).toEqual(['esc']);
  });

  it('runs a chord inside its window and shows the hint meanwhile', () => {
    expect(press({ key: 'k', code: 'KeyK', metaKey: true }).defaultPrevented).toBe(true);
    press({ key: 'r', code: 'KeyR', metaKey: true });
    expect(ran).toEqual(['chorded']);
    expect(hint).toEqual([true, false]);
  });

  it('drops a chord after 2.5 seconds', () => {
    vi.useFakeTimers();
    try {
      press({ key: 'k', code: 'KeyK', metaKey: true });
      vi.advanceTimersByTime(2600);
      press({ key: 'r', code: 'KeyR', metaKey: true });
      expect(ran).toEqual([]);
      expect(hint).toEqual([true, false]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves a local row to its component, which matches it exactly', () => {
    expect(press({ key: 'Enter', code: 'Enter', metaKey: true }).defaultPrevented).toBe(false);
    expect(ran).toEqual([]);
    expect(matches(ev({ key: 'Enter', code: 'Enter', metaKey: true }), 'box')).toBe(true);
    expect(matches(ev({ key: 'Enter', code: 'Enter', metaKey: true, shiftKey: true }), 'box')).toBe(false);
  });

  it('labels bindings the macOS way', () => {
    expect(keyLabel('yes')).toBe('⌘Y');
    expect(keyLabel('yes', 'last')).toBe('⌘⇧Y');
    expect(keyLabel('chorded')).toBe('⌘K ⌘R');
    expect(keyLabel('box')).toBe('⌘↩');
    expect(keyLabel('missing')).toBe('');
    expect(hintFor('box')).toBe('');
    expect(hintFor('yes')).toBe('⌘Y');
    expect(chords()).toEqual([{ prefix: '⌘K', next: '⌘R', command: 'chorded' }]);
  });
});
