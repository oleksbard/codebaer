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
  localStorage.removeItem('codebaer.avatars');
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
    expect(items.map((i) => i.textContent)).toEqual(['Open Folder…⌘O', 'OTother-~/projects/other']);
    items[1]!.click();
    expect(c.openRepo).toHaveBeenCalledWith('/Users/me/projects/other');
  });

  it('opens the folder picker from the first item', async () => {
    await openRepoAt('/Users/me/projects/reviewbaer', '~/projects/reviewbaer', null);
    (await openMenu())[0]!.click();
    expect(c.pickRepo).toHaveBeenCalledTimes(1);
  });

  it('marks the open repo with an avatar from its displayed name, in a theme hue', async () => {
    await openRepoAt('/Users/me/projects/reviewbaer', '~/projects/reviewbaer', 'CodeBär');
    const avatar = trigger()!.querySelector<HTMLElement>('.repo-avatar')!;
    expect(avatar.textContent).toBe('CB');
    expect(avatar.style.getPropertyValue('--hue')).toMatch(/^var\(--hue-[a-z]+\)$/);
  });

  it('gives every recent repo an avatar no other repo in the menu has', async () => {
    vi.mocked(git.recentRepos).mockResolvedValue([
      { path: '/Users/me/work/reviewbaer', name: 'reviewbaer', label: '~/work/reviewbaer' },
      { path: '/Users/me/projects/bunch-portal', name: 'bunch-portal', label: '~/projects/bunch-portal' },
    ]);
    await openRepoAt('/Users/me/projects/reviewbaer', '~/projects/reviewbaer', null);
    await openMenu();
    const codes = [...document.querySelectorAll('.repo-avatar')].map((a) => a.textContent);
    expect(codes).toEqual(['RE', 'RV', 'BP']);
  });

  it('forgets the avatars of repos that left the recents once the list loads', async () => {
    localStorage.setItem('codebaer.avatars', JSON.stringify({ '/gone': { code: 'RE', name: 'reviewbaer' } }));
    await openRepoAt('/Users/me/projects/reviewbaer', '~/projects/reviewbaer', null);
    expect(trigger()!.querySelector('.repo-avatar')!.textContent).toBe('RV');
    await openMenu();
    expect(Object.keys(JSON.parse(localStorage.getItem('codebaer.avatars')!) as object))
      .toEqual(['/Users/me/projects/reviewbaer']);
    expect(trigger()!.querySelector('.repo-avatar')!.textContent).toBe('RV');
  });
});
