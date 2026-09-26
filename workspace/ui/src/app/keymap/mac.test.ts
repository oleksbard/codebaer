import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { hintFor, installKeys, keyLabel, type Binding } from '#kernel/keymap';
import { MAC } from './mac';

const calls: string[] = [];

beforeAll(() => {
  installKeys((c) => { calls.push(c); });
});

afterEach(() => {
  calls.length = 0;
  document.body.replaceChildren();
});

type Init = { key: string; code: string; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean; ctrlKey?: boolean };

function press(init: Init) {
  const event = new KeyboardEvent('keydown', {
    key: init.key,
    code: init.code,
    metaKey: init.metaKey ?? false,
    altKey: init.altKey ?? false,
    shiftKey: init.shiftKey ?? false,
    ctrlKey: init.ctrlKey ?? false,
    bubbles: true,
    cancelable: true,
  });
  document.body.dispatchEvent(event);
  return event;
}

const at = (cls: string): HTMLTextAreaElement => {
  const host = document.body.appendChild(document.createElement('div'));
  host.className = cls;
  return host.appendChild(document.createElement('textarea'));
};
const send = (el: Element, init: Init): KeyboardEvent => {
  const event = new KeyboardEvent('keydown', {
    key: init.key, code: init.code, metaKey: !!init.metaKey, altKey: !!init.altKey, shiftKey: !!init.shiftKey,
    ctrlKey: !!init.ctrlKey, bubbles: true, cancelable: true,
  });
  el.dispatchEvent(event);
  return event;
};

describe('keys on macOS', () => {
  it('Alt+F5 -> nextHunk', () => {
    press({ key: 'F5', code: 'F5', altKey: true });
    expect(calls).toEqual(['review.nextHunk']);
  });

  it('Shift+Alt+F5 -> prevHunk', () => {
    press({ key: 'F5', code: 'F5', altKey: true, shiftKey: true });
    expect(calls).toEqual(['review.prevHunk']);
  });

  it('F7 -> nextHunk', () => {
    press({ key: 'F7', code: 'F7' });
    expect(calls).toEqual(['review.nextHunk']);
  });

  it('Shift+F7 -> prevHunk', () => {
    press({ key: 'F7', code: 'F7', shiftKey: true });
    expect(calls).toEqual(['review.prevHunk']);
  });

  it('Meta+KeyY -> accept', () => {
    press({ key: 'y', code: 'KeyY', metaKey: true });
    expect(calls).toEqual(['review.accept']);
  });

  it('Meta+Shift+KeyY -> acceptFile', () => {
    press({ key: 'y', code: 'KeyY', metaKey: true, shiftKey: true });
    expect(calls).toEqual(['review.stageFile']);
  });

  it('Meta+Alt+KeyY -> stageAll', () => {
    press({ key: 'y', code: 'KeyY', metaKey: true, altKey: true });
    expect(calls).toEqual(['review.stageAll']);
  });

  it('Meta+KeyN -> reject', () => {
    press({ key: 'n', code: 'KeyN', metaKey: true });
    expect(calls).toEqual(['review.reject']);
  });

  it('Meta+Shift+KeyN -> rejectFile', () => {
    press({ key: 'n', code: 'KeyN', metaKey: true, shiftKey: true });
    expect(calls).toEqual(['review.discardFile']);
  });

  it('Meta+Shift+BracketRight -> nextFile', () => {
    press({ key: ']', code: 'BracketRight', metaKey: true, shiftKey: true });
    expect(calls).toEqual(['review.nextFile']);
  });

  it('Meta+Shift+BracketLeft -> prevFile', () => {
    press({ key: '[', code: 'BracketLeft', metaKey: true, shiftKey: true });
    expect(calls).toEqual(['review.prevFile']);
  });

  it('Meta+Shift+KeyE -> filesTab', () => {
    press({ key: 'e', code: 'KeyE', metaKey: true, shiftKey: true });
    expect(calls).toEqual(['files.show']);
  });

  it('Meta+Digit0 -> focusList', () => {
    press({ key: '0', code: 'Digit0', metaKey: true });
    expect(calls).toEqual(['app.focusList']);
  });

  it('Meta+Digit1 -> focusEditor', () => {
    press({ key: '1', code: 'Digit1', metaKey: true });
    expect(calls).toEqual(['core.focusEditor']);
  });

  it('Meta+KeyS -> save', () => {
    press({ key: 's', code: 'KeyS', metaKey: true });
    expect(calls).toEqual(['core.save']);
  });

  it('Meta+KeyP -> quickOpen', () => {
    press({ key: 'p', code: 'KeyP', metaKey: true });
    expect(calls).toEqual(['files.quickOpen']);
  });

  it('Meta+Shift+KeyP -> palette', () => {
    press({ key: 'p', code: 'KeyP', metaKey: true, shiftKey: true });
    expect(calls).toEqual(['app.palette']);
  });

  it('Ctrl+Shift+KeyG -> focusCommit', () => {
    press({ key: 'g', code: 'KeyG', ctrlKey: true, shiftKey: true });
    expect(calls).toEqual(['git.focusCommit']);
  });

  it('Meta+KeyB -> toggleSidebar', () => {
    press({ key: 'b', code: 'KeyB', metaKey: true });
    expect(calls).toEqual(['app.toggleSidebar']);
  });

  it('Escape -> escape, and does not call preventDefault', () => {
    const event = press({ key: 'Escape', code: 'Escape' });
    expect(calls).toEqual(['core.escape']);
    expect(event.defaultPrevented).toBe(false);
  });

  it('Meta+Alt+KeyN types a character, no dispatch', () => {
    const event = press({ key: 'n', code: 'KeyN', metaKey: true, altKey: true });
    expect(calls).toEqual([]);
    expect(event.defaultPrevented).toBe(false);
  });

  it('Meta+Shift+Alt+KeyY -> no dispatch', () => {
    const event = press({ key: 'y', code: 'KeyY', metaKey: true, shiftKey: true, altKey: true });
    expect(calls).toEqual([]);
    expect(event.defaultPrevented).toBe(false);
  });

  it('Meta+Shift+Digit0 and Meta+Shift+Digit1 -> no dispatch', () => {
    const zero = press({ key: ')', code: 'Digit0', metaKey: true, shiftKey: true });
    const one = press({ key: '!', code: 'Digit1', metaKey: true, shiftKey: true });
    expect(calls).toEqual([]);
    expect(zero.defaultPrevented).toBe(false);
    expect(one.defaultPrevented).toBe(false);
  });

  it('Meta+Alt+KeyP -> no dispatch', () => {
    const event = press({ key: 'p', code: 'KeyP', metaKey: true, altKey: true });
    expect(calls).toEqual([]);
    expect(event.defaultPrevented).toBe(false);
  });

  it('chord Meta+KeyK then plain KeyN cancels the chord, then Meta+KeyN -> reject', () => {
    press({ key: 'k', code: 'KeyK', metaKey: true });
    const cancelEvent = press({ key: 'n', code: 'KeyN' });
    expect(calls).toEqual([]);
    expect(cancelEvent.defaultPrevented).toBe(false);
    press({ key: 'n', code: 'KeyN', metaKey: true });
    expect(calls).toEqual(['review.reject']);
  });

  it('chord Meta+KeyK then Meta+KeyN -> unstage', () => {
    press({ key: 'k', code: 'KeyK', metaKey: true });
    press({ key: 'n', code: 'KeyN', metaKey: true });
    expect(calls).toEqual(['review.unstageHunk']);
  });

  it('chord Meta+KeyK then Meta+Alt+KeyS -> accept', () => {
    press({ key: 'k', code: 'KeyK', metaKey: true });
    press({ key: 's', code: 'KeyS', metaKey: true, altKey: true });
    expect(calls).toEqual(['review.accept']);
  });

  it('chord Meta+KeyK then Meta+KeyR -> reject', () => {
    press({ key: 'k', code: 'KeyK', metaKey: true });
    press({ key: 'r', code: 'KeyR', metaKey: true });
    expect(calls).toEqual(['review.reject']);
  });

  it('the comment chord does nothing in a terminal, and Escape in a comment box skips the global escape', () => {
    const inTerm = at('term-host');
    send(inTerm, { key: 'k', code: 'KeyK', metaKey: true });
    send(inTerm, { key: 'ç', code: 'KeyC', metaKey: true, altKey: true });
    send(at('comment-box'), { key: 'Escape', code: 'Escape' });
    expect(calls).toEqual([]);
    document.body.replaceChildren();
  });

  it('chord Meta+KeyK then Meta+Alt+KeyC -> comment, and Meta+Alt+KeyC alone does nothing', () => {
    press({ key: 'ç', code: 'KeyC', metaKey: true, altKey: true });
    expect(calls).toEqual([]);
    press({ key: 'k', code: 'KeyK', metaKey: true });
    press({ key: 'ç', code: 'KeyC', metaKey: true, altKey: true });
    expect(calls).toEqual(['comments.start']);
  });

  it('keeps the terminal-safe keys working inside a terminal', () => {
    const el = at('term-host');
    const keys: [Init, string][] = [
      [{ key: 't', code: 'KeyT', metaKey: true }, 'terminals.new'],
      [{ key: 't', code: 'KeyT', metaKey: true, shiftKey: true }, 'terminals.show'],
      [{ key: '2', code: 'Digit2', metaKey: true }, 'terminals.focus'],
      [{ key: 'p', code: 'KeyP', metaKey: true, shiftKey: true }, 'app.palette'],
      [{ key: 'p', code: 'KeyP', metaKey: true }, 'files.quickOpen'],
      [{ key: 'b', code: 'KeyB', metaKey: true }, 'app.toggleSidebar'],
      [{ key: 'e', code: 'KeyE', metaKey: true, shiftKey: true }, 'files.show'],
      [{ key: '0', code: 'Digit0', metaKey: true }, 'app.focusList'],
      [{ key: '1', code: 'Digit1', metaKey: true }, 'core.focusEditor'],
    ];
    for (const [init, action] of keys) {
      const event = send(el, init);
      expect(calls.pop()).toBe(action);
      expect(event.defaultPrevented).toBe(true);
    }
  });

  it('leaves every other key to the terminal, unprevented', () => {
    const el = at('term-host');
    for (const init of [
      { key: 'y', code: 'KeyY', metaKey: true }, { key: 'n', code: 'KeyN', metaKey: true },
      { key: 's', code: 'KeyS', metaKey: true }, { key: 'F7', code: 'F7' }, { key: 'Escape', code: 'Escape' },
      { key: 'F5', code: 'F5', altKey: true }, { key: 'g', code: 'KeyG', ctrlKey: true, shiftKey: true },
    ]) {
      expect(send(el, init).defaultPrevented).toBe(false);
    }
    expect(calls).toEqual([]);
  });

  it('drops a chord 2.5 seconds after it started', () => {
    vi.useFakeTimers();
    try {
      press({ key: 'k', code: 'KeyK', metaKey: true });
      vi.advanceTimersByTime(2600);
      press({ key: 'n', code: 'KeyN', metaKey: true });
      expect(calls).toEqual(['review.reject']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('matches modifiers exactly: no stray Alt, Shift or Cmd', () => {
    expect(press({ key: 'e', code: 'KeyE', metaKey: true, shiftKey: true, altKey: true }).defaultPrevented).toBe(false);
    press({ key: 'F7', code: 'F7', metaKey: true });
    press({ key: 'k', code: 'KeyK', metaKey: true });
    press({ key: 'r', code: 'KeyR', metaKey: true, shiftKey: true });
    expect(calls).toEqual([]);
  });

  it('leaves Cmd-Enter, Cmd-, and Cmd-O to their component or the menu', () => {
    for (const init of [
      { key: 'Enter', code: 'Enter', metaKey: true }, { key: ',', code: 'Comma', metaKey: true },
      { key: 'o', code: 'KeyO', metaKey: true },
    ]) expect(press(init).defaultPrevented).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe('the macOS table', () => {
  const scopes = (b: Binding): string[] => (b.local ? ['app'] : b.in === 'any' ? ['app', 'terminal'] : [b.in ?? 'app']);
  const norm = (keys: string): string => keys.split(' ').map((s) => s.split('+').sort().join('+')).join(' ');
  const overlap = (x: string, y: string): boolean => x === y || x.startsWith(`${y} `) || y.startsWith(`${x} `);

  it('never binds one key sequence twice where both could fire', () => {
    const clashes: string[] = [];
    MAC.forEach((a, i) => {
      for (const b of MAC.slice(i + 1)) {
        // two components each own their box; the global handler, first in the capture phase, would take either's key
        if (!overlap(norm(a.keys), norm(b.keys)) || (a.local && b.local)) continue;
        if (!scopes(a).some((s) => scopes(b).includes(s))) continue;
        clashes.push(`${a.keys} ${a.command} / ${b.keys} ${b.command}`);
      }
    });
    expect(clashes).toEqual([]);
  });

  it.each([
    ['app.palette', '⌘⇧P'], ['repos.pick', '⌘O'], ['settings.open', '⌘,'], ['review.stageAll', '⌘⌥Y'],
    ['review.stageFile', '⌘⇧Y'], ['review.discardFile', '⌘⇧N'], ['git.commit', '⌘↩'], ['comments.save', '⌘↩'],
    ['comments.send', '⌘⇧↩'], ['terminals.new', '⌘T'], ['review.reject', '⌘N'], ['review.accept', '⌘Y'],
    ['review.unstageHunk', '⌘K ⌘N'], ['comments.start', '⌘K ⌘⌥C'], ['review.nextHunk', '⌥F5'],
  ])('labels %s as %s', (id, label) => {
    expect(keyLabel(id)).toBe(label);
  });

  it('labels the plain hunk keys where the buttons name them', () => {
    expect(keyLabel('review.nextHunk', 'last')).toBe('F7');
    expect(keyLabel('review.prevHunk', 'last')).toBe('⇧F7');
  });

  it('gives the palette no hint for a key that only works in one place', () => {
    expect(hintFor('repos.pick')).toBe('');
    expect(hintFor('comments.send')).toBe('');
    expect(hintFor('comments.start')).toBe('⌘K ⌘⌥C');
  });
});
