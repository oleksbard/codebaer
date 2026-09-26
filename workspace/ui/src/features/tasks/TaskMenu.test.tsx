import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { icons as lucide } from '@iconify-json/lucide';
import type { Info, TermState } from '#ipc/terminal';
import { tick } from '#test-setup';

vi.mock('./runner', () => ({
  closeTask: vi.fn(), openTask: vi.fn(), promoteTask: vi.fn(),
  runTask: vi.fn(), taskMenu: vi.fn(),
}));
vi.mock('#features/terminals', async () => ({
  ...(await vi.importActual<object>('#features/terminals')),
  killTerminal: vi.fn(), mount: vi.fn(), focus: vi.fn(), fit: vi.fn(),
}));
vi.mock('#features/settings', async () => ({
  ...(await vi.importActual<object>('#features/settings')), openSettings: vi.fn(),
}));
vi.mock('#ipc/git', async () => ({
  ...(await vi.importActual<object>('#ipc/git')),
  git: {
    commandIcons: vi.fn(() => Promise.resolve({ 'build\nvite build': 'lucide:hammer' })),
    aiCommandIcons: vi.fn(), saveCommandIcons: vi.fn(() => Promise.resolve()),
  },
}));

const c = await import('./runner');
const term = await import('#features/terminals');
const settings = await import('#features/settings');
const { git } = await import('#ipc/git');
const { S, notify } = await import('#kernel/store');
const { TaskMenu, TaskOverlay } = await import('./TaskMenu');

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
    { name: 'Lint', command: 'pnpm lint', repo: HERE, hide_terminal: false, icon: null },
    { name: '', command: 'make deploy', repo: null, hide_terminal: true, icon: null },
    { name: 'Theirs', command: 'cargo test', repo: '/Users/me/projects/lib', hide_terminal: false, icon: null },
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

it('shows each script\'s command without the words they all start with, and the full one as the title', async () => {
  vi.mocked(c.taskMenu).mockResolvedValue({
    runner: 'pnpm', scripts: [
      { name: 'dev', command: 'pnpm --filter ui dev' }, { name: 'e2e', command: 'pnpm --filter ui e2e --ci' },
    ],
  });
  const items = await openMenu();
  const scripts = items.filter((i) => ['dev', 'e2e'].includes(i.querySelector('.name')?.textContent ?? ''));
  expect(scripts.map((i) => i.querySelector('.detail')!.textContent)).toEqual(['… dev', '… e2e --ci']);
  expect(scripts.map((i) => i.title)).toEqual(['pnpm --filter ui dev', 'pnpm --filter ui e2e --ci']);
  // a saved command with no name of its own is its own label, across both columns
  expect(item(items, 'make deploy').querySelector('.name.wide')!.textContent).toBe('make deploy');
});

it('runs the command picked as it was saved, and a script by its name', async () => {
  item(await openMenu(), 'Lint').click();
  expect(c.runTask).toHaveBeenCalledWith(
    { t: 'Custom', name: 'Lint', command: 'pnpm lint', repo: HERE, hide_terminal: false, icon: null },
  );
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

it('answers a pick with an animation only when no dialog is going to', async () => {
  const icon = () => document.querySelector('.task-b .tab-icon')!;
  item(await openMenu(), 'Lint').click();
  await tick();
  item(await openMenu(), 'build').click();
  await tick();
  expect(icon().classList.contains('launch')).toBe(false);

  item(await openMenu(), 'make deploy').click();
  await tick();
  const first = icon();
  expect(first.classList.contains('launch')).toBe(true);
  item(await openMenu(), 'make deploy').click();
  await tick();
  // a new element, so the animation plays again rather than staying finished
  expect(icon()).not.toBe(first);
  expect(c.runTask).toHaveBeenCalledTimes(4);
});

it('opens Settings on the Commands section', async () => {
  item(await openMenu(), 'Manage commands').click();
  expect(settings.openSettings).toHaveBeenCalledWith('commands');
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
  expect(term.killTerminal).toHaveBeenCalledWith(4);

  S.terminals = [task(4, { t: 'Exited', code: 143 })];
  notify();
  await tick();
  expect(button('Stop')).toBeUndefined();
  expect(document.querySelector('.task-state')!.textContent).toBe('stopped');
  button('Move to Terminals')!.click();
  expect(c.promoteTask).toHaveBeenCalledWith(4);
});

it('asks for icons for the unpicked commands it lists and their scripts, and draws each pick', async () => {
  S.settings = { ...S.settings, 'general.headless-ai-provider': 'claude' };
  S.commands = [
    ...S.commands.slice(0, 2),
    { name: 'Deploy', command: './deploy.sh', repo: null, hide_terminal: false, icon: 'lucide:rocket' },
  ];
  vi.mocked(git.aiCommandIcons).mockResolvedValue(['lucide:brush-cleaning', null, 'lucide:flask-conical']);
  await openMenu();
  await vi.waitFor(() => expect(git.aiCommandIcons).toHaveBeenCalledOnce());
  expect(vi.mocked(git.aiCommandIcons).mock.calls[0]![0]).toEqual([
    { name: 'Lint', command: 'pnpm lint' }, { name: '', command: 'make deploy' },
    { name: 'test', command: 'vitest run' },
  ]);
  await tick();
  const drawn = (text: string) =>
    item([...document.querySelectorAll<HTMLElement>('.task-menu .menu-item')], text).querySelector('.cicon svg')!;
  const path = (name: string) => /\bd="([^"]+)"/.exec(lucide.icons[name]!.body)![1];
  const picks = { Lint: 'brush-cleaning', Deploy: 'rocket', build: 'hammer', test: 'flask-conical' };
  for (const [text, icon] of Object.entries(picks)) {
    expect(drawn(text).querySelector('path')!.getAttribute('d'), text).toBe(path(icon));
  }
  // no icon came back, so it keeps the stand-in
  expect(drawn('make deploy').getAttribute('viewBox')).toBe('0 0 16 16');
  S.settings = { ...S.settings, 'general.headless-ai-provider': 'off' };
});

it('closes through the runner, which decides whether the task goes too', async () => {
  S.terminals = [task(4, { t: 'Exited', code: 0 })];
  S.taskView = 4;
  flushSync(() => root.render(<TaskOverlay />));
  await tick();
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await tick();
  expect(c.closeTask).toHaveBeenCalledTimes(1);
});
