import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { tick } from '#test-setup';

vi.mock('#core/session', () => ({ pickRepo: vi.fn(), openRepo: vi.fn() }));
vi.mock('#ipc/git', async () => {
  const actual = await vi.importActual<typeof import('#ipc/git')>('#ipc/git');
  return { ...actual, git: { recentRepos: vi.fn(), favoriteRepo: vi.fn() } };
});

import type { Recent } from '#ipc/git';

const c = await import('#core/session');
const { git } = await import('#ipc/git');
const { S, notify } = await import('#kernel/store');
const { Header } = await import('#app/Shell');

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

const repo = (name: string, favorite = false): Recent =>
  ({ path: `/Users/me/projects/${name}`, name, label: `~/projects/${name}`, favorite });
const names = (): string[] => [...document.querySelectorAll('.repo-item .name')].map((n) => n.textContent);
const stars = (): string[] =>
  [...document.querySelectorAll<HTMLElement>('.repo-star')].map((b) => b.getAttribute('aria-pressed')!);
const row = (name: string): HTMLElement => [...document.querySelectorAll<HTMLElement>('.repo-item')]
  .find((r) => r.querySelector('.name')!.textContent === name)!;

async function openMenu(): Promise<HTMLElement[]> {
  trigger()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await tick();
  return [...document.querySelectorAll<HTMLElement>('.menu-item')];
}

describe('header repo switcher', () => {
  it('is absent until a repo is open', () => {
    expect(trigger()).toBeNull();
    expect(head().querySelector('.palette-field')).not.toBeNull();
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
      { path: '/Users/me/projects/other', name: 'other', label: '~/projects/other', favorite: false },
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
      { path: '/Users/me/work/reviewbaer', name: 'reviewbaer', label: '~/work/reviewbaer', favorite: false },
      { path: '/Users/me/projects/bunch-portal', name: 'bunch-portal', label: '~/projects/bunch-portal',
        favorite: false },
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

  it('puts the favorites first, apart from the rest, with their stars on', async () => {
    vi.mocked(git.recentRepos).mockResolvedValue([repo('fav', true), repo('other')]);
    await openRepoAt('/Users/me/projects/reviewbaer', '~/projects/reviewbaer', null);
    const menu = (await openMenu())[0]!.parentElement!;
    expect([...menu.children].map((e) => e.className.includes('menu-sep') ? '-' : e.textContent))
      .toEqual(['Open Folder…⌘O', '-', 'FAfav-~/projects/fav', '-', 'OTother-~/projects/other']);
    expect(stars()).toEqual(['true', 'false']);
  });

  it('stars a repo from its star without opening it, and shows the order the backend answers', async () => {
    vi.mocked(git.recentRepos).mockResolvedValue([repo('one'), repo('two')]);
    vi.mocked(git.favoriteRepo).mockResolvedValue([repo('two', true), repo('one')]);
    await openRepoAt('/Users/me/projects/reviewbaer', '~/projects/reviewbaer', null);
    await openMenu();
    row('two').querySelector<HTMLButtonElement>('.repo-star')!.click();
    await tick();
    expect(git.favoriteRepo).toHaveBeenCalledWith('/Users/me/projects/two', true);
    expect(c.openRepo).not.toHaveBeenCalled();
    expect(names()).toEqual(['two', 'one']);
    expect(stars()).toEqual(['true', 'false']);
    expect(row('two').querySelector('.repo-star')!.getAttribute('title')).toBe('Remove from favorites (⌘D)');
  });

  it('unstars the highlighted row on Cmd-D and keeps it focused where it moved', async () => {
    vi.mocked(git.recentRepos).mockResolvedValue([repo('one', true), repo('two', true), repo('three')]);
    vi.mocked(git.favoriteRepo).mockResolvedValue([repo('two', true), repo('one'), repo('three')]);
    await openRepoAt('/Users/me/projects/reviewbaer', '~/projects/reviewbaer', null);
    await openMenu();
    row('one').focus();
    row('one').dispatchEvent(new KeyboardEvent('keydown', { key: 'd', code: 'KeyD', metaKey: true, bubbles: true }));
    await tick();
    expect(git.favoriteRepo).toHaveBeenCalledWith('/Users/me/projects/one', false);
    expect(c.openRepo).not.toHaveBeenCalled();
    expect(names()).toEqual(['two', 'one', 'three']);
    expect(document.activeElement).toBe(row('one'));
  });
});
