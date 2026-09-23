import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import type { Info } from './terminal';

vi.mock('./app/controller', () => ({
  closeTerminal: vi.fn(), killTerminal: vi.fn(), newTerminal: vi.fn(), selectTerminal: vi.fn(),
}));

const { S } = await import('./app/store');
const { TerminalRail } = await import('./app/Terminals');

const session = (id: number, cwd: string): Info => ({ id, title: 'zsh', cwd, tier: 'marks', state: { t: 'Idle' } });

let root: Root;

beforeEach(() => {
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
  expect(button(2).getAttribute('aria-label')).toBe('zsh · ~/other · outside the repo');
});
