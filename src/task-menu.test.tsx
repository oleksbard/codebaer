import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import type { Info, TermState } from './terminal';
import { tick } from './test-setup';

vi.mock('./app/controller', () => ({
  closeTask: vi.fn(), killTerminal: vi.fn(), openSettings: vi.fn(), openTask: vi.fn(), promoteTask: vi.fn(),
  runTask: vi.fn(), taskMenu: vi.fn(),
}));
vi.mock('./terminal', async () => {
  const actual = await vi.importActual<typeof import('./terminal')>('./terminal');
  return { ...actual, mount: vi.fn(), focus: vi.fn(), fit: vi.fn() };
});

const c = await import('./app/controller');
const term = await import('./terminal');
const { S, notify } = await import('./app/store');
const { TaskMenu, TaskOverlay } = await import('./app/Tasks');

const HERE = '/Users/me/projects/app';
const task = (id: number, state: TermState): Info =>
  ({ id, title: 'pnpm test', cwd: HERE, tier: 'process', state, task: true });

let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = '<div id="host"></div>';
  S.root = HERE;
  S.terminals = [];
  S.taskView = null;
  S.commands = [
    { name: 'Lint', command: 'pnpm lint', repo: HERE },
    { name: '', command: 'make deploy', repo: null },
    { name: 'Theirs', command: 'cargo test', repo: '/Users/me/projects/lib' },
  ];
  vi.mocked(c.taskMenu).mockResolvedValue({
    runner: 'pnpm', scripts: [{ name: 'build', command: 'vite build' }, { name: 'test', command: 'vitest run' }],
  });
  root = createRoot(document.getElementById('host')!);
});

afterEach(() => {
  root.unmount();
  document.body.innerHTML = '';
});

async function openMenu(): Promise<HTMLElement[]> {
  flushSync(() => root.render(<TaskMenu />));
  document.querySelector('.task-b')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await tick();
  await tick();
  return [...document.querySelectorAll<HTMLElement>('.task-menu .menu-item')];
}

const item = (items: HTMLElement[], text: string) => items.find((i) => i.textContent.startsWith(text))!;

it('lists this repo\'s commands, the global ones and the package.json scripts, and not another repo\'s', async () => {
  const items = await openMenu();
  expect(items.map((i) => i.textContent)).toEqual([
    'Lintpnpm lint', 'make deploy', 'buildvite build', 'testvitest run', 'Manage commands…',
  ]);
  expect(document.querySelector('.task-menu')!.textContent).toContain('package.json · pnpm');
});

it('runs the command picked as it was saved, and a script by its name', async () => {
  item(await openMenu(), 'Lint').click();
  expect(c.runTask).toHaveBeenCalledWith({ t: 'Custom', name: 'Lint', command: 'pnpm lint', repo: HERE });
  item(await openMenu(), 'test').click();
  expect(c.runTask).toHaveBeenLastCalledWith({ t: 'Script', name: 'test' });
});

it('says what went wrong with package.json instead of listing nothing', async () => {
  vi.mocked(c.taskMenu).mockRejectedValue({ kind: 'Io', detail: 'package.json: expected value at line 1' });
  await openMenu();
  expect(document.querySelector('.task-menu')!.textContent).toContain('package.json: expected value at line 1');
});

it('lists running and ended tasks so a closed dialog can be opened again', async () => {
  S.terminals = [
    task(4, { t: 'Running', command: null, since_ms: Date.now() }), task(5, { t: 'Exited', code: 1 }),
    { id: 6, title: 'zsh', cwd: HERE, tier: 'marks', state: { t: 'Idle' } },
  ];
  const items = await openMenu();
  expect(items.slice(0, 2).map((i) => i.textContent)).toEqual(['pnpm testrunning 0s', 'pnpm testfailed with exit 1']);
  expect(document.querySelector('.task-b')!.getAttribute('aria-label')).toBe('Commands - 1 running');
  items[1]!.click();
  expect(c.openTask).toHaveBeenCalledWith(5);
});

it('opens Settings on the Commands section', async () => {
  item(await openMenu(), 'Manage commands').click();
  expect(c.openSettings).toHaveBeenCalledWith('commands');
});

it('shows the task\'s output, offers Stop only while it runs, and moves it to the rail', async () => {
  S.terminals = [task(4, { t: 'Running', command: null, since_ms: Date.now() })];
  S.taskView = 4;
  flushSync(() => root.render(<TaskOverlay />));
  await tick();
  const host = document.querySelector<HTMLElement>('.dialog.task .term-host')!;
  expect(term.mount).toHaveBeenCalledWith(4, host);
  const button = (label: string) =>
    [...document.querySelectorAll<HTMLButtonElement>('.task-acts button')].find((b) => b.textContent === label);
  button('Stop')!.click();
  expect(c.killTerminal).toHaveBeenCalledWith(4);

  S.terminals = [task(4, { t: 'Exited', code: 143 })];
  notify();
  await tick();
  expect(button('Stop')).toBeUndefined();
  expect(document.querySelector('.task-state')!.textContent).toBe('stopped');
  button('Move to Terminals')!.click();
  expect(c.promoteTask).toHaveBeenCalledWith(4);
});

it('closes through the controller, which decides whether the task goes too', async () => {
  S.terminals = [task(4, { t: 'Exited', code: 0 })];
  S.taskView = 4;
  flushSync(() => root.render(<TaskOverlay />));
  await tick();
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await tick();
  expect(c.closeTask).toHaveBeenCalledTimes(1);
});
