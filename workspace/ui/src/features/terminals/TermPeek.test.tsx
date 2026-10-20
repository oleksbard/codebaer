import { afterEach, beforeEach, expect, it } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { notify, S } from '#kernel/store';
import { exitTick, tick } from '#test-setup';
import { TermPeek } from './TermPeek';

let root: Root;
const card = () => document.querySelector<HTMLElement>('.hovercard.term-peek');

beforeEach(() => {
  document.body.innerHTML = '<div id="host"></div>';
  root = createRoot(document.getElementById('host')!);
  flushSync(() => root.render(<TermPeek />));
});

afterEach(() => {
  S.termPeek = null;
  root.unmount();
  document.body.innerHTML = '';
});

it('shows the lines around the named one, with that line marked, and goes when the peek does', async () => {
  S.termPeek = {
    id: 1, at: { x: 40, top: 20, bottom: 36 }, path: 'src/a.ts', line: 2,
    body: { kind: 'code', first: 1, line: 2, lines: [[{ text: 'one', cls: '' }], [{ text: 'two', cls: 'k' }]] },
  };
  notify();
  await tick();

  expect(card()?.getAttribute('role')).toBe('tooltip');
  expect(card()?.querySelector('.term-peek-path')?.textContent).toBe('src/a.ts:2');
  expect([...card()!.querySelectorAll('.term-peek-code > div')].map((r) => [r.className, r.textContent]))
    .toEqual([['', '1one'], ['on', '2two']]);
  // in the body, not under the terminal, so a dialog's own stacking cannot hide it
  expect(card()?.parentElement).toBe(document.body);

  S.termPeek = null;
  notify();
  await exitTick();
  expect(card()).toBeNull();
});

it('draws a markdown page from its sanitized html, and a note as text', async () => {
  S.termPeek = { id: 2, at: { x: 0, top: 0, bottom: 16 }, path: 'README.md', line: null,
    body: { kind: 'markdown', html: '<h1>Title</h1>' } };
  notify();
  await tick();
  expect(card()?.querySelector('.term-peek-md h1')?.textContent).toBe('Title');

  S.termPeek = { id: 3, at: { x: 0, top: 0, bottom: 16 }, path: 'big.bin', line: null,
    body: { kind: 'note', text: '<b>Binary</b>' } };
  notify();
  await exitTick();
  expect(card()?.querySelector('.term-peek-note')?.textContent).toBe('<b>Binary</b>');
});
