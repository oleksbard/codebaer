import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { icons as lucide } from '@iconify-json/lucide';
import type { Info } from '#ipc/terminal';
import { tick } from '#test-setup';

vi.mock('./sessions', () => ({
  closeTerminal: vi.fn(), killTerminal: vi.fn(), newTerminal: vi.fn(), selectTerminal: vi.fn(),
}));
vi.mock('#ipc/git', async () => ({
  ...(await vi.importActual<object>('#ipc/git')),
  git: {
    commandIcons: vi.fn(() => Promise.resolve({})), aiCommandIcons: vi.fn(),
    saveCommandIcons: vi.fn(() => Promise.resolve()),
  },
}));

const { git } = await import('#ipc/git');
const { S } = await import('#kernel/store');
const { closeTerminal, killTerminal } = await import('./sessions');
const { TerminalRail } = await import('./Terminals');

const session = (id: number, cwd: string): Info => ({ id, title: 'zsh', cwd, tier: 'marks', state: { t: 'Idle' } });

let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = '<div id="host"></div>';
  S.tab = 'terminals';
  S.activeTerm = null;
  S.termAttention = new Set();
  S.root = '/Users/me/projects/x';
  S.termMenu = null;
  S.termIcons = new Map();
  root = createRoot(document.getElementById('host')!);
});

afterEach(() => {
  root.unmount();
  document.body.innerHTML = '';
});

/** By its place, since an ended session shows no number. */
const button = (id: number): HTMLButtonElement =>
  document.querySelectorAll<HTMLButtonElement>('.rail-b:not(.new)')[S.terminals.findIndex((t) => t.id === id)]!;

it('marks only the session that left the repo, and says so in its label', () => {
  S.terminals = [session(1, '/Users/me/projects/x/src'), session(2, '/Users/me/other')];
  flushSync(() => root.render(<TerminalRail />));

  expect(button(1).querySelector('.away')).toBeNull();
  expect(button(1).classList.contains('outside')).toBe(false);
  expect(button(1).getAttribute('aria-label')).not.toContain('outside');
  expect(button(2).querySelector('.away')).not.toBeNull();
  expect(button(2).classList.contains('outside')).toBe(true);
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

it('gives each new-terminal entry an icon: an agent its own mark, a runtime its language, anything else a terminal',
  async () => {
    S.terminals = [];
    S.termMenu = {
      shells: [{ path: '/bin/zsh', name: 'zsh' }], default: '/bin/zsh', commands: ['claude', 'node', 'bun'],
    };
    flushSync(() => root.render(<TerminalRail />));
    document.querySelector('.rail-b.new')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await tick();

    const icons = [...document.querySelectorAll('.term-menu .prog')].map((p) => {
      if (p.classList.contains('agent')) return p.className;
      if (p.querySelector('.ficon svg')) return 'language';
      return p.querySelector(':scope > svg rect') ? 'terminal' : 'none';
    });
    expect(icons).toEqual(['terminal', 'prog agent claude', 'language', 'terminal']);
  });

it('draws the icon picked for a shell\'s first long command and for a program in place of the number', async () => {
  S.settings = { ...S.settings, 'general.headless-ai-provider': 'claude' };
  const here = '/Users/me/projects/x';
  S.terminals = [
    session(1, here), session(2, here),
    { id: 3, title: 'htop', cwd: here, tier: 'process', state: { t: 'Running', command: null, since_ms: 0 } },
  ];
  S.termIcons = new Map([[2, { name: '', command: 'pnpm dev', icon: null }]]);
  vi.mocked(git.aiCommandIcons).mockResolvedValue(['lucide:play', 'lucide:activity']);
  flushSync(() => root.render(<TerminalRail />));

  await vi.waitFor(() => expect(document.querySelectorAll('.rail-b .pick svg')).toHaveLength(2));
  expect(vi.mocked(git.aiCommandIcons).mock.calls[0]![0]).toEqual([
    { name: '', command: 'pnpm dev' }, { name: '', command: 'htop' },
  ]);
  const path = (name: string) => /\bd="([^"]+)"/.exec(lucide.icons[name]!.body)![1];
  const tiles = [...document.querySelectorAll('.rail-b:not(.new) .tile')];
  expect(tiles.map((t) => t.querySelector('.num')?.textContent ?? t.querySelector('.pick path')?.getAttribute('d')))
    .toEqual(['1', path('play'), path('activity')]);
  S.settings = { ...S.settings, 'general.headless-ai-provider': 'off' };
});

it('draws every killed or finished session with the same icon, agents too, and asks for none of them', () => {
  S.settings = { ...S.settings, 'general.headless-ai-provider': 'claude' };
  const here = '/Users/me/projects/x';
  const ended = (id: number, title: string, code: number | null): Info =>
    ({ ...session(id, here), title, tier: 'process', state: { t: 'Exited', code } });
  S.terminals = [ended(1, 'zsh', 0), ended(2, 'claude', null), ended(3, 'htop', 1), session(4, here)];
  S.termIcons = new Map([[1, { name: '', command: 'pnpm dev', icon: null }]]);
  flushSync(() => root.render(<TerminalRail />));

  const tiles = [...document.querySelectorAll('.rail-b:not(.new) .tile')];
  const drawn = tiles.map((t) => t.querySelector('.ended svg')?.innerHTML ?? t.querySelector('.num')?.textContent);
  expect(drawn.slice(0, 3).every((d) => d === drawn[0] && d !== undefined)).toBe(true);
  expect(drawn[3]).toBe('4');
  expect(git.aiCommandIcons).not.toHaveBeenCalled();
  expect(git.commandIcons).not.toHaveBeenCalled();
  S.settings = { ...S.settings, 'general.headless-ai-provider': 'off' };
});

it('draws the agent\'s mark while one runs in a shell that has an icon', () => {
  S.terminals = [{ ...session(1, '/Users/me/projects/x'), state: { t: 'Running', command: 'claude', since_ms: 0 } }];
  S.termIcons = new Map([[1, { name: '', command: 'pnpm dev', icon: 'lucide:play' }]]);
  flushSync(() => root.render(<TerminalRail />));
  expect(button(1).querySelector('.agent.claude')).not.toBeNull();
  expect(button(1).querySelector('.pick')).toBeNull();
});
