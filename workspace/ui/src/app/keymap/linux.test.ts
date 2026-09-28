import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Binding } from '#kernel/keymap';

type Keymap = typeof import('#kernel/keymap');
let keys: Keymap;
let LINUX: readonly Binding[];
const calls: string[] = [];

// test-setup loaded the key engine for jsdom's platform, which counts as macOS, so it is loaded again for Linux
beforeAll(async () => {
  Object.defineProperty(navigator, 'platform', { value: 'Linux x86_64', configurable: true });
  vi.resetModules();
  keys = await import('#kernel/keymap');
  ({ LINUX } = await import('./linux'));
  keys.setKeymap(LINUX);
  keys.installKeys((c) => { calls.push(c); });
});

afterEach(() => {
  calls.length = 0;
  document.body.replaceChildren();
});

type Init = { key: string; code: string; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean; metaKey?: boolean };

const send = (el: Element, init: Init): KeyboardEvent => {
  const event = new KeyboardEvent('keydown', {
    key: init.key, code: init.code, ctrlKey: !!init.ctrlKey, altKey: !!init.altKey, shiftKey: !!init.shiftKey,
    metaKey: !!init.metaKey, bubbles: true, cancelable: true,
  });
  el.dispatchEvent(event);
  return event;
};
const press = (init: Init): KeyboardEvent => send(document.body, init);
const at = (cls: string): HTMLTextAreaElement => {
  const host = document.body.appendChild(document.createElement('div'));
  host.className = cls;
  return host.appendChild(document.createElement('textarea'));
};

describe('keys on Linux', () => {
  it.each([
    [{ key: 'y', code: 'KeyY', ctrlKey: true }, 'review.accept'],
    [{ key: 'Y', code: 'KeyY', ctrlKey: true, shiftKey: true }, 'review.stageFile'],
    [{ key: 'y', code: 'KeyY', ctrlKey: true, altKey: true }, 'review.stageAll'],
    [{ key: 'n', code: 'KeyN', ctrlKey: true }, 'review.reject'],
    [{ key: '}', code: 'BracketRight', ctrlKey: true, shiftKey: true }, 'review.nextFile'],
    [{ key: 'F7', code: 'F7' }, 'review.nextHunk'],
    [{ key: 's', code: 'KeyS', ctrlKey: true }, 'core.save'],
    [{ key: ',', code: 'Comma', ctrlKey: true }, 'settings.open'],
    [{ key: 'o', code: 'KeyO', ctrlKey: true }, 'repos.pick'],
    [{ key: 'q', code: 'KeyQ', ctrlKey: true }, 'app.quit'],
    [{ key: 'p', code: 'KeyP', ctrlKey: true }, 'files.quickOpen'],
    [{ key: 'P', code: 'KeyP', ctrlKey: true, shiftKey: true }, 'app.palette'],
    [{ key: 'b', code: 'KeyB', ctrlKey: true }, 'app.toggleSidebar'],
    [{ key: 't', code: 'KeyT', ctrlKey: true }, 'terminals.new'],
    [{ key: 'T', code: 'KeyT', ctrlKey: true, shiftKey: true }, 'terminals.show'],
    [{ key: 'G', code: 'KeyG', ctrlKey: true, shiftKey: true }, 'git.focusCommit'],
  ])('%o -> %s', (init, command) => {
    expect(press(init).defaultPrevented).toBe(true);
    expect(calls).toEqual([command]);
  });

  it('runs the chords on Ctrl', () => {
    press({ key: 'k', code: 'KeyK', ctrlKey: true });
    press({ key: 'r', code: 'KeyR', ctrlKey: true });
    expect(calls).toEqual(['review.reject']);
  });

  it('leaves Alt+F5 to the desktop and Cmd to nothing', () => {
    for (const init of [
      { key: 'F5', code: 'F5', altKey: true }, { key: 'y', code: 'KeyY', metaKey: true },
      { key: 'p', code: 'KeyP', metaKey: true, shiftKey: true },
    ]) expect(press(init).defaultPrevented).toBe(false);
    expect(calls).toEqual([]);
  });

  it('leaves plain Ctrl to the shell inside a terminal', () => {
    const el = at('term-host');
    for (const code of ['KeyP', 'KeyB', 'KeyT', 'KeyN', 'KeyY', 'KeyS', 'KeyO', 'KeyQ', 'Digit0', 'Digit1', 'Digit2']) {
      expect(send(el, { key: code.slice(-1).toLowerCase(), code, ctrlKey: true }).defaultPrevented).toBe(false);
    }
    send(el, { key: 'k', code: 'KeyK', ctrlKey: true });
    send(el, { key: 'r', code: 'KeyR', ctrlKey: true });
    expect(calls).toEqual([]);
  });

  it('answers to Ctrl+Shift inside a terminal', () => {
    const el = at('term-host');
    const cases: [Init, string][] = [
      [{ key: 'P', code: 'KeyP', ctrlKey: true, shiftKey: true }, 'app.palette'],
      [{ key: 'T', code: 'KeyT', ctrlKey: true, shiftKey: true }, 'terminals.new'],
      [{ key: 'B', code: 'KeyB', ctrlKey: true, shiftKey: true }, 'app.toggleSidebar'],
      [{ key: 'E', code: 'KeyE', ctrlKey: true, shiftKey: true }, 'files.show'],
      [{ key: ')', code: 'Digit0', ctrlKey: true, shiftKey: true }, 'app.focusList'],
      [{ key: '!', code: 'Digit1', ctrlKey: true, shiftKey: true }, 'core.focusEditor'],
    ];
    for (const [init, command] of cases) {
      expect(send(el, init).defaultPrevented).toBe(true);
      expect(calls.pop()).toBe(command);
    }
  });

  it('gives copy and paste to the terminal itself', () => {
    const el = at('term-host');
    const copy = { key: 'C', code: 'KeyC', ctrlKey: true, shiftKey: true, altKey: false, metaKey: false };
    expect(send(el, copy).defaultPrevented).toBe(false);
    expect(keys.matches(copy, 'terminals.copy')).toBe(true);
    expect(keys.matches({ key: 'V', code: 'KeyV', ctrlKey: true, shiftKey: true, altKey: false, metaKey: false },
      'terminals.paste')).toBe(true);
    expect(calls).toEqual([]);
  });
});

describe('the Linux table', () => {
  const scopes = (b: Binding): string[] => (b.local ? ['app'] : b.in === 'any' ? ['app', 'terminal'] : [b.in ?? 'app']);
  const norm = (k: string): string => k.split(' ').map((s) => s.split('+').sort().join('+')).join(' ');
  const overlap = (x: string, y: string): boolean => x === y || x.startsWith(`${y} `) || y.startsWith(`${x} `);

  it('never binds one key sequence twice where both could fire', () => {
    const clashes: string[] = [];
    LINUX.forEach((a, i) => {
      for (const b of LINUX.slice(i + 1)) {
        if (!overlap(norm(a.keys), norm(b.keys)) || (a.local && b.local)) continue;
        if (!scopes(a).some((s) => scopes(b).includes(s))) continue;
        clashes.push(`${a.keys} ${a.command} / ${b.keys} ${b.command}`);
      }
    });
    expect(clashes).toEqual([]);
  });

  it('binds no plain Ctrl key where a terminal has focus', () => {
    const plain = LINUX.filter((b) => !b.local && b.in !== undefined && b.in !== 'app'
      && b.keys.split(' ').some((s) => /^(Mod|Ctrl)\+(?!.*Shift)/.test(s)));
    expect(plain.map((b) => b.keys)).toEqual([]);
  });

  it.each([
    ['app.palette', 'Ctrl+Shift+P'], ['review.stageAll', 'Ctrl+Alt+Y'], ['review.accept', 'Ctrl+Y'],
    ['review.unstageHunk', 'Ctrl+K Ctrl+N'], ['comments.start', 'Ctrl+K Ctrl+Alt+C'], ['git.commit', 'Ctrl+Enter'],
    ['review.nextHunk', 'F7'], ['review.prevHunk', 'Shift+F7'], ['terminals.new', 'Ctrl+T'],
  ])('labels %s as %s', (id, label) => {
    expect(keys.keyLabel(id)).toBe(label);
  });
});
