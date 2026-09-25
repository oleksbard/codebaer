import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import type { Info } from './terminal';
import { tick } from './test-setup';

vi.mock('./app/controller', () => ({
  closeTerminal: vi.fn(), killTerminal: vi.fn(), newTerminal: vi.fn(), selectTerminal: vi.fn(),
}));

const { S } = await import('./app/store');
const { closeTerminal, killTerminal } = await import('./app/controller');
const { TerminalRail } = await import('./app/Terminals');

const session = (id: number, cwd: string): Info => ({ id, title: 'zsh', cwd, tier: 'marks', state: { t: 'Idle' } });

let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = '<div id="host"></div>';
  S.tab = 'terminals';
  S.activeTerm = null;
  S.termAttention = new Set();
  S.root = '/Users/me/projects/x';
  root = createRoot(document.getElementById('host')!);
});

afterEach(() => {
  root.unmount();
  document.body.innerHTML = '';
});

const button = (id: number): HTMLButtonElement =>
  [...document.querySelectorAll<HTMLButtonElement>('.rail-b')].find((b) => b.textContent.includes(String(id)))!;

it('marks only the session that left the repo, and says so in its label', () => {
  S.terminals = [session(1, '/Users/me/projects/x/src'), session(2, '/Users/me/other')];
  flushSync(() => root.render(<TerminalRail />));

  expect(button(1).querySelector('.away')).toBeNull();
  expect(button(1).getAttribute('aria-label')).not.toContain('outside');
  expect(button(2).querySelector('.away')).not.toBeNull();
  expect(button(2).getAttribute('aria-label')).toBe('zsh:2 · ~/other · outside the repo');
});

const menu = async (id: number): Promise<HTMLElement[]> => {
  button(id).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
  await tick();
  return [...document.querySelectorAll<HTMLElement>('.menu-item')];
};

it.each([
  ['Kill', killTerminal, closeTerminal],
  ['Kill & Close', closeTerminal, killTerminal],
])('offers Kill and Kill & Close on a live session, and %s runs only its action', async (label, runs, skips) => {
  S.terminals = [session(1, '/Users/me/projects/x')];
  flushSync(() => root.render(<TerminalRail />));

  const items = await menu(1);
  expect(items.map((i) => i.textContent)).toEqual(['Kill', 'Kill & Close']);
  items.find((i) => i.textContent === label)!.click();
  expect(runs).toHaveBeenCalledExactlyOnceWith(1);
  expect(skips).not.toHaveBeenCalled();
});

it('offers only Close on an exited session', async () => {
  S.terminals = [{ ...session(1, '/Users/me/projects/x'), state: { t: 'Exited', code: 0 } }];
  flushSync(() => root.render(<TerminalRail />));

  expect((await menu(1)).map((i) => i.textContent)).toEqual(['Close']);
});

it('gives a task no button until it is moved to the rail', () => {
  S.terminals = [session(1, '/Users/me/projects/x'), { ...session(2, '/Users/me/projects/x'), task: true }];
  flushSync(() => root.render(<TerminalRail />));
  expect([...document.querySelectorAll('.rail-b:not(.new)')].map((b) => b.getAttribute('aria-label')))
    .toEqual(['zsh:1 · ~/projects/x']);
});
