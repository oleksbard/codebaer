import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { tick } from './test-setup';

vi.mock('./app/controller', () => ({ palette: vi.fn(), pickRepo: vi.fn(), openRepo: vi.fn() }));
vi.mock('./git', async () => {
  const actual = await vi.importActual<typeof import('./git')>('./git');
  return { ...actual, git: { recentRepos: vi.fn() } };
});

const c = await import('./app/controller');
const { git } = await import('./git');
const { S, notify } = await import('./app/store');
const { Header } = await import('./app/Shell');

let root: Root;
const head = () => document.querySelector<HTMLElement>('.head')!;
const trigger = () => head().querySelector<HTMLButtonElement>('.repo-trigger');

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(git.recentRepos).mockResolvedValue([]);
  document.body.innerHTML = '<div id="host"></div>';
  S.root = null; S.rootLabel = null; S.title = null;
  root = createRoot(document.getElementById('host')!);
  flushSync(() => root.render(<Header />));
});

afterEach(() => {
  root.unmount();
  document.body.innerHTML = '';
});

async function openRepoAt(path: string, label: string, title: string | null): Promise<void> {
  S.root = path; S.rootLabel = label; S.title = title;
  notify();
  await tick();
}

async function openMenu(): Promise<HTMLElement[]> {
  trigger()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await tick();
  return [...document.querySelectorAll<HTMLElement>('.menu-item')];
}

describe('header repo switcher', () => {
  it('is absent until a repo is open', () => {
    expect(trigger()).toBeNull();
    expect(head().querySelector('.cmd-field')).not.toBeNull();
  });

  it('names the repo by its folder, with the full path on hover', async () => {
    await openRepoAt('/Users/me/projects/reviewbaer', '~/projects/reviewbaer', null);
    expect(trigger()!.querySelector('.name')!.textContent).toBe('reviewbaer');
    expect(trigger()!.title).toBe('~/projects/reviewbaer - switch project');
  });

  it('prefers the repo title over the folder name', async () => {
    await openRepoAt('/Users/me/projects/reviewbaer', '~/projects/reviewbaer', 'CodeBär');
    expect(trigger()!.querySelector('.name')!.textContent).toBe('CodeBär');
  });

  it('lists Open Folder and the recent repos, and opens the one picked', async () => {
    vi.mocked(git.recentRepos).mockResolvedValue([
      { path: '/Users/me/projects/other', name: 'other', label: '~/projects/other' },
    ]);
    await openRepoAt('/Users/me/projects/reviewbaer', '~/projects/reviewbaer', null);
    const items = await openMenu();
    expect(items.map((i) => i.textContent)).toEqual(['Open Folder…⌘O', 'other-~/projects/other']);
    items[1]!.click();
    expect(c.openRepo).toHaveBeenCalledWith('/Users/me/projects/other');
  });

  it('opens the folder picker from the first item', async () => {
    await openRepoAt('/Users/me/projects/reviewbaer', '~/projects/reviewbaer', null);
    (await openMenu())[0]!.click();
    expect(c.pickRepo).toHaveBeenCalledTimes(1);
  });
});
