import { beforeEach, describe, expect, it } from 'vitest';
import { keepFocus, lastFocusOutside, restoreFocusTo } from './focus';

function fireCloseAutoFocus(content: HTMLElement, handler: (e: Event) => void): Event {
  const event = new Event('closeAutoFocus', { cancelable: true });
  Object.defineProperty(event, 'currentTarget', { value: content });
  handler(event);
  return event;
}

describe('keepFocus', () => {
  it('does not prevent the default restore when nothing has moved focus away', () => {
    const content = document.createElement('div');
    document.body.append(content);
    document.body.focus();
    const event = fireCloseAutoFocus(content, keepFocus);
    expect(event.defaultPrevented).toBe(false);
    content.remove();
  });

  it('prevents the default restore once a command has focused something else in that window', () => {
    const content = document.createElement('div');
    const elsewhere = document.createElement('button');
    document.body.append(content, elsewhere);
    elsewhere.focus();
    const event = fireCloseAutoFocus(content, keepFocus);
    expect(event.defaultPrevented).toBe(true);
    content.remove();
    elsewhere.remove();
  });

  it('does not prevent it for focus still inside the closing content itself', () => {
    const content = document.createElement('div');
    const inside = document.createElement('button');
    content.append(inside);
    document.body.append(content);
    inside.focus();
    const event = fireCloseAutoFocus(content, keepFocus);
    expect(event.defaultPrevented).toBe(false);
    content.remove();
  });
});

describe('restoreFocusTo', () => {
  let opener: HTMLButtonElement;
  let content: HTMLDivElement;

  beforeEach(() => {
    opener = document.createElement('button');
    content = document.createElement('div');
    document.body.append(opener, content);
  });

  it('restores focus to the opener when nothing else has claimed it (focus still on body)', () => {
    document.body.focus();
    fireCloseAutoFocus(content, restoreFocusTo(opener));
    expect(document.activeElement).toBe(opener);
  });

  it('restores focus to the opener when focus is still inside the closing dialog', () => {
    const inside = document.createElement('button');
    content.append(inside);
    inside.focus();
    fireCloseAutoFocus(content, restoreFocusTo(opener));
    expect(document.activeElement).toBe(opener);
  });

  it('leaves focus alone once a command has already moved it elsewhere (not body, not inside the dialog)', () => {
    const elsewhere = document.createElement('button');
    document.body.append(elsewhere);
    elsewhere.focus();
    fireCloseAutoFocus(content, restoreFocusTo(opener));
    expect(document.activeElement).toBe(elsewhere);
  });

  it('always prevents Radix\'s own default (a no-op restore to a Trigger these dialogs do not have)', () => {
    document.body.focus();
    const event = fireCloseAutoFocus(content, restoreFocusTo(opener));
    expect(event.defaultPrevented).toBe(true);
  });

  it('is a no-op with a null opener', () => {
    document.body.focus();
    expect(() => fireCloseAutoFocus(content, restoreFocusTo(null))).not.toThrow();
  });

  it('does not restore to an opener that has since left the document', () => {
    const inside = document.createElement('button');
    content.append(inside);
    inside.focus();
    opener.remove();
    fireCloseAutoFocus(content, restoreFocusTo(opener));
    expect(document.activeElement).toBe(inside);
  });
});

describe('lastFocusOutside', () => {
  it('is the element last focused outside any menu, dialog or alert dialog', () => {
    const row = document.createElement('button');
    document.body.append(row);
    row.focus();
    expect(lastFocusOutside()).toBe(row);
    row.remove();
  });

  it('ignores focus inside a role="menu", a role="dialog" or a role="alertdialog"', () => {
    const row = document.createElement('button');
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    const item = document.createElement('button');
    menu.append(item);
    document.body.append(row, menu);
    row.focus();
    item.focus();
    expect(lastFocusOutside()).toBe(row);
    row.remove();
    menu.remove();
  });

  it('is null once the element it tracked has left the document', () => {
    const row = document.createElement('button');
    document.body.append(row);
    row.focus();
    row.remove();
    expect(lastFocusOutside()).toBeNull();
  });
});
