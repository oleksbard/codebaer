import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import type { Info } from '#ipc/terminal';
import { tick } from '#test-setup';

vi.mock('#ipc/git', async () => {
  const actual = await vi.importActual<typeof import('#ipc/git')>('#ipc/git');
  return { ...actual, git: { recentRepos: vi.fn() } };
});

const { git } = await import('#ipc/git');
const { S } = await import('#kernel/store');
const { OutsideBadge } = await import('./OutsideBadge');

const session = (cwd: string, over: Partial<Info> = {}): Info =>
  ({ id: 1, title: 'zsh', cwd, tier: 'marks', state: { t: 'Idle' }, ...over });

let root: Root;
const badge = () => document.querySelector<HTMLElement>('.term-outside');
const frame = () => document.querySelector<HTMLElement>('.term-frame')!;

async function show(s: Info): Promise<void> {
  flushSync(() => root.render(<div className="term-frame"><OutsideBadge session={s} /></div>));
  await tick();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(git.recentRepos).mockResolvedValue([
    { path: '/Users/me/projects/x', name: 'x', label: '~/projects/x', favorite: false },
    { path: '/Users/me/projects/web', name: 'Web Site', label: '~/projects/web', favorite: false },
  ]);
  localStorage.removeItem('codebaer.avatars');
  document.body.innerHTML = '<div id="host"></div>';
  S.root = '/Users/me/projects/x';
  root = createRoot(document.getElementById('host')!);
});

afterEach(() => {
  root.unmount();
  document.body.innerHTML = '';
});

it('stays away while the session works in the open repo, or has exited elsewhere', async () => {
  await show(session('/Users/me/projects/x/src'));
  expect(badge()).toBeNull();
  await show(session('/Users/me/other', { state: { t: 'Exited', code: 0 } }));
  expect(badge()).toBeNull();
  expect(git.recentRepos).not.toHaveBeenCalled();
});

it('names the recent repo the session works in, with its avatar and the folder below it', async () => {
  await show(session('/Users/me/projects/web/src'));
  expect(badge()!.querySelector('.repo-avatar')!.textContent).toBe('WS');
  expect(badge()!.querySelector('.name')!.textContent).toBe('Web Site');
  expect(badge()!.querySelector('.tail')!.textContent).toBe('/src');
  expect(badge()!.querySelector('.where')!.textContent).toBe('Web Site/src');
});

it('names the folder when no recent repo holds it', async () => {
  await show(session('/Users/me/projects/blog'));
  expect(badge()!.querySelector('.repo-avatar')).toBeNull();
  expect(badge()!.querySelector('.folder')).not.toBeNull();
  expect(badge()!.textContent).toBe('Outside the repo, in ~/projects/blog');
});

it('fades while the pointer is near it, even when the terminal keeps the event to itself', async () => {
  await show(session('/Users/me/other'));
  vi.spyOn(badge()!, 'getBoundingClientRect').mockReturnValue(new DOMRect(12, 8, 180, 28));
  const inner = document.createElement('div');
  frame().append(inner);
  inner.addEventListener('pointermove', (e) => e.stopPropagation());
  const move = (x: number, y: number) =>
    inner.dispatchEvent(new PointerEvent('pointermove', { clientX: x, clientY: y, bubbles: true }));

  move(100, 20);
  expect(badge()!.hasAttribute('data-near')).toBe(true);
  move(100, 200);
  expect(badge()!.hasAttribute('data-near')).toBe(false);
  move(210, 50);
  expect(badge()!.hasAttribute('data-near')).toBe(true);
  frame().dispatchEvent(new PointerEvent('pointerleave'));
  expect(badge()!.hasAttribute('data-near')).toBe(false);
});
