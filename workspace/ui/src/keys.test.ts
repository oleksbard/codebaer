import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { installKeys, type Action } from './keys';

const calls: Action[] = [];
const dispatch = (a: Action) => { calls.push(a); };

beforeAll(() => {
  installKeys(dispatch);
});

afterEach(() => {
  calls.length = 0;
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

describe('installKeys', () => {
  it('Alt+F5 -> nextHunk', () => {
    press({ key: 'F5', code: 'F5', altKey: true });
    expect(calls).toEqual(['nextHunk']);
  });

  it('Shift+Alt+F5 -> prevHunk', () => {
    press({ key: 'F5', code: 'F5', altKey: true, shiftKey: true });
    expect(calls).toEqual(['prevHunk']);
  });

  it('F7 -> nextHunk', () => {
    press({ key: 'F7', code: 'F7' });
    expect(calls).toEqual(['nextHunk']);
  });

  it('Shift+F7 -> prevHunk', () => {
    press({ key: 'F7', code: 'F7', shiftKey: true });
    expect(calls).toEqual(['prevHunk']);
  });

  it('Meta+KeyY -> accept', () => {
    press({ key: 'y', code: 'KeyY', metaKey: true });
    expect(calls).toEqual(['accept']);
  });

  it('Meta+Shift+KeyY -> acceptFile', () => {
    press({ key: 'y', code: 'KeyY', metaKey: true, shiftKey: true });
    expect(calls).toEqual(['acceptFile']);
  });

  it('Meta+Alt+KeyY -> stageAll', () => {
    press({ key: 'y', code: 'KeyY', metaKey: true, altKey: true });
    expect(calls).toEqual(['stageAll']);
  });

  it('Meta+KeyN -> reject', () => {
    press({ key: 'n', code: 'KeyN', metaKey: true });
    expect(calls).toEqual(['reject']);
  });

  it('Meta+Shift+KeyN -> rejectFile', () => {
    press({ key: 'n', code: 'KeyN', metaKey: true, shiftKey: true });
    expect(calls).toEqual(['rejectFile']);
  });

  it('Meta+Shift+BracketRight -> nextFile', () => {
    press({ key: ']', code: 'BracketRight', metaKey: true, shiftKey: true });
    expect(calls).toEqual(['nextFile']);
  });

  it('Meta+Shift+BracketLeft -> prevFile', () => {
    press({ key: '[', code: 'BracketLeft', metaKey: true, shiftKey: true });
    expect(calls).toEqual(['prevFile']);
  });

  it('Meta+Shift+KeyE -> filesTab', () => {
    press({ key: 'e', code: 'KeyE', metaKey: true, shiftKey: true });
    expect(calls).toEqual(['filesTab']);
  });

  it('Meta+Digit0 -> focusList', () => {
    press({ key: '0', code: 'Digit0', metaKey: true });
    expect(calls).toEqual(['focusList']);
  });

  it('Meta+Digit1 -> focusEditor', () => {
    press({ key: '1', code: 'Digit1', metaKey: true });
    expect(calls).toEqual(['focusEditor']);
  });

  it('Meta+KeyS -> save', () => {
    press({ key: 's', code: 'KeyS', metaKey: true });
    expect(calls).toEqual(['save']);
  });

  it('Meta+KeyP -> quickOpen', () => {
    press({ key: 'p', code: 'KeyP', metaKey: true });
    expect(calls).toEqual(['quickOpen']);
  });

  it('Meta+Shift+KeyP -> palette', () => {
    press({ key: 'p', code: 'KeyP', metaKey: true, shiftKey: true });
    expect(calls).toEqual(['palette']);
  });

  it('Ctrl+Shift+KeyG -> focusCommit', () => {
    press({ key: 'g', code: 'KeyG', ctrlKey: true, shiftKey: true });
    expect(calls).toEqual(['focusCommit']);
  });

  it('Meta+KeyB -> toggleSidebar', () => {
    press({ key: 'b', code: 'KeyB', metaKey: true });
    expect(calls).toEqual(['toggleSidebar']);
  });

  it('Escape -> escape, and does not call preventDefault', () => {
    const event = press({ key: 'Escape', code: 'Escape' });
    expect(calls).toEqual(['escape']);
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
    expect(calls).toEqual(['reject']);
  });

  it('chord Meta+KeyK then Meta+KeyN -> unstage', () => {
    press({ key: 'k', code: 'KeyK', metaKey: true });
    press({ key: 'n', code: 'KeyN', metaKey: true });
    expect(calls).toEqual(['unstage']);
  });

  it('chord Meta+KeyK then Meta+Alt+KeyS -> accept', () => {
    press({ key: 'k', code: 'KeyK', metaKey: true });
    press({ key: 's', code: 'KeyS', metaKey: true, altKey: true });
    expect(calls).toEqual(['accept']);
  });

  it('chord Meta+KeyK then Meta+KeyR -> reject', () => {
    press({ key: 'k', code: 'KeyK', metaKey: true });
    press({ key: 'r', code: 'KeyR', metaKey: true });
    expect(calls).toEqual(['reject']);
  });

  it('the comment chord does nothing in a terminal, and Escape in a comment box skips the global escape', () => {
    const at = (cls: string) => {
      const host = document.body.appendChild(document.createElement('div'));
      host.className = cls;
      return host.appendChild(document.createElement('textarea'));
    };
    const send = (el: Element, init: Init) => el.dispatchEvent(new KeyboardEvent('keydown', {
      key: init.key, code: init.code, metaKey: !!init.metaKey, altKey: !!init.altKey, bubbles: true, cancelable: true,
    }));
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
    expect(calls).toEqual(['comment']);
  });
});
