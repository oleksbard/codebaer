import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { exitTick, setValue, tick, tipOf } from '#test-setup';

vi.mock('#core/session', () => ({ pickRepo: vi.fn(), openRepo: vi.fn(), closeRepo: vi.fn(), lastRepo: vi.fn() }));
vi.mock('#ipc/git', async () => {
  const actual = await vi.importActual<typeof import('#ipc/git')>('#ipc/git');
  return { ...actual, git: { recentRepos: vi.fn(), favoriteRepo: vi.fn(), aiRepoIcons: vi.fn() } };
});

import type { Recent } from '#ipc/git';

const c = await import('#core/session');
const { git } = await import('#ipc/git');
const { S, notify, useApp } = await import('#kernel/store');
const { Header } = await import('#app/Shell');
const { RepoPrefsOverlay } = await import('./RepoPrefsDialog');
const { NoRepo } = await import('./NoRepo');
const { Presence } = await import('#ui/Presence');

/** The registered overlay's own presence, the way `app/OverlayHost.tsx` gives it one: `isOpen()` (here
 *  `S.repoPrefs !== null`) decides whether the element is even in `Presence`'s children this render. */
function Overlays() {
  const s = useApp();
  return <Presence>{s.repoPrefs !== null && <RepoPrefsOverlay key="repo-prefs" />}</Presence>;
}

let root: Root;
const head = () => document.querySelector<HTMLElement>('.head')!;
const trigger = () => head().querySelector<HTMLButtonElement>('.repo-trigger');

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(git.recentRepos).mockResolvedValue([]);
  localStorage.removeItem('codebaer.avatars');
  localStorage.removeItem('codebaer.repo-icons');
  document.body.innerHTML = '<div id="host"></div>';
  S.root = null; S.rootLabel = null; S.title = null; S.repoPrefs = null;
  root = createRoot(document.getElementById('host')!);
  flushSync(() => root.render(<><Header /><Overlays /></>));
});

afterEach(() => {
  root.unmount();
  document.body.innerHTML = '';
  setAi('off');
});

async function openRepoAt(path: string, label: string, title: string | null): Promise<void> {
  S.root = path; S.rootLabel = label; S.title = title;
  notify();
  await tick();
}

const HERE = '/Users/me/projects/reviewbaer';
const openHere = (title: string | null = null) => openRepoAt(HERE, '~/projects/reviewbaer', title);
const repo = (name: string, favorite = false): Recent =>
  ({ path: `/Users/me/projects/${name}`, name, label: `~/projects/${name}`, favorite });
const setAi = (provider: 'claude' | 'off') => {
  S.settings = { ...S.settings, 'general.headless-ai-provider': provider };
};
const row = (name: string): HTMLElement => [...document.querySelectorAll<HTMLElement>('.repo-item')]
  .find((r) => r.querySelector('.name')!.textContent === name)!;
const item = (text: string): HTMLElement => [...document.querySelectorAll<HTMLElement>('.menu-item')]
  .find((i) => i.textContent === text)!;
const dialog = () => document.querySelector<HTMLElement>('.repo-prefs');

async function openMenu(): Promise<HTMLElement[]> {
  trigger()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await tick();
  return [...document.querySelectorAll<HTMLElement>('.menu-item')];
}

describe('header repo switcher', () => {
  it('says there is no repository until one is open, and offers only Open Folder and the recents', async () => {
    vi.mocked(git.recentRepos).mockResolvedValue([repo('other')]);
    expect(trigger()!.querySelector('.name')!.textContent).toBe('No repository');
    expect(trigger()!.querySelector('.repo-avatar')).toBeNull();
    expect((await openMenu()).map((i) => i.textContent)).toEqual(['Open Folder…⌘O', 'OTother-~/projects/other']);
  });

  it('names the repo by its folder, with the full path on hover', async () => {
    await openHere();
    expect(trigger()!.querySelector('.name')!.textContent).toBe('reviewbaer');
    expect(await tipOf(trigger()!)).toBe('Switch project~/projects/reviewbaer');
  });

  it('prefers the repo title over the folder name', async () => {
    await openHere('CodeBär');
    expect(trigger()!.querySelector('.name')!.textContent).toBe('CodeBär');
  });

  it('lists the other recent repos between its own items, and opens the one picked', async () => {
    vi.mocked(git.recentRepos).mockResolvedValue([repo('reviewbaer'), repo('other')]);
    await openHere();
    const items = await openMenu();
    expect(items.map((i) => i.textContent)).toEqual([
      'Open Folder…⌘O', 'Repository Preferences…', 'OTother-~/projects/other', 'Close Repository',
    ]);
    row('other').click();
    expect(c.openRepo).toHaveBeenCalledWith('/Users/me/projects/other');
  });

  it('opens the folder picker from the first item, and closes the repo from the last', async () => {
    await openHere();
    (await openMenu())[0]!.click();
    expect(c.pickRepo).toHaveBeenCalledTimes(1);
    (await openMenu()).at(-1)!.click();
    expect(c.closeRepo).toHaveBeenCalledTimes(1);
  });

  it('marks the open repo with an avatar from its displayed name, in a theme hue', async () => {
    await openHere('CodeBär');
    const avatar = trigger()!.querySelector<HTMLElement>('.repo-avatar')!;
    expect(avatar.textContent).toBe('CB');
    expect(avatar.style.getPropertyValue('--hue')).toMatch(/^var\(--hue-[a-z]+\)$/);
  });

  it('gives every recent repo an avatar no other repo in the menu has', async () => {
    vi.mocked(git.recentRepos).mockResolvedValue([
      { path: '/Users/me/work/reviewbaer', name: 'reviewbaer', label: '~/work/reviewbaer', favorite: false },
      repo('bunch-portal'),
    ]);
    await openHere();
    await openMenu();
    const codes = [...document.querySelectorAll('.repo-avatar')].map((a) => a.textContent);
    expect(codes).toEqual(['RE', 'RV', 'BP']);
  });

  it('forgets the avatars of repos that left the recents once the list loads', async () => {
    localStorage.setItem('codebaer.avatars', JSON.stringify({ '/gone': { code: 'RE', name: 'reviewbaer' } }));
    await openHere();
    expect(trigger()!.querySelector('.repo-avatar')!.textContent).toBe('RV');
    await openMenu();
    expect(Object.keys(JSON.parse(localStorage.getItem('codebaer.avatars')!) as object)).toEqual([HERE]);
    expect(trigger()!.querySelector('.repo-avatar')!.textContent).toBe('RV');
  });

  it('puts the favorites first, apart from the rest, with a star on their avatars', async () => {
    vi.mocked(git.recentRepos).mockResolvedValue([repo('fav', true), repo('reviewbaer', true), repo('other')]);
    await openHere();
    const menu = (await openMenu())[0]!.parentElement!;
    expect([...menu.children].map((e) => e.className.includes('menu-sep') ? '-' : e.textContent)).toEqual([
      'Open Folder…⌘O', 'Repository Preferences…', '-', 'FAfav, favorite-~/projects/fav', '-',
      'OTother-~/projects/other', '-', 'Close Repository',
    ]);
    expect(row('fav').querySelector('.repo-avatar .repo-fav')).not.toBeNull();
    expect(row('other').querySelector('.repo-fav')).toBeNull();
    expect(trigger()!.querySelector('.repo-fav')).toBeNull();
  });
});

describe('repository preferences', () => {
  const box = () => dialog()!.querySelector<HTMLButtonElement>('[role="checkbox"]')!;
  const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((b) => b.textContent === name || b.getAttribute('aria-label') === name)!;

  async function openPrefs(recents: Recent[]): Promise<void> {
    vi.mocked(git.recentRepos).mockResolvedValue(recents);
    await openHere('CodeBär');
    await openMenu();
    item('Repository Preferences…').click();
    await vi.waitFor(() => expect(dialog()).not.toBeNull());
  }

  it('opens for the open repo only, with its favorite mark as the backend has it', async () => {
    await openPrefs([{ ...repo('reviewbaer', true), name: 'CodeBär' }, repo('other')]);
    expect(dialog()!.querySelector('.dialog-title')!.textContent).toBe('CodeBär');
    expect(dialog()!.querySelector('.path')!.textContent).toBe('~/projects/reviewbaer');
    expect(box().getAttribute('aria-checked')).toBe('true');
    expect(dialog()!.querySelector('.repo-prefs-head .repo-fav')).not.toBeNull();
  });

  it('stars and unstars the repo, and shows what the backend kept', async () => {
    await openPrefs([repo('reviewbaer')]);
    vi.mocked(git.favoriteRepo).mockResolvedValueOnce([repo('reviewbaer', true)]).mockResolvedValueOnce([]);
    dialog()!.querySelector<HTMLElement>('.repo-prefs-check label')!.click();
    await tick();
    expect(git.favoriteRepo).toHaveBeenLastCalledWith(HERE, true);
    expect(box().getAttribute('aria-checked')).toBe('true');
    box().click();
    await tick();
    expect(git.favoriteRepo).toHaveBeenLastCalledWith(HERE, false);
    expect(box().getAttribute('aria-checked')).toBe('false');
  });

  it('keeps the checkbox off when the backend would not keep the favorite', async () => {
    await openPrefs([]);
    vi.mocked(git.favoriteRepo).mockResolvedValue([]);
    box().click();
    await tick();
    expect(box().getAttribute('aria-checked')).toBe('false');
  });

  it('draws the icon picked for the repo everywhere, over the AI\'s, and Automatic hands it back', async () => {
    const ai = { body: '<path d="M1 1h4"/>', width: 24, height: 24 };
    localStorage.setItem('codebaer.avatars', JSON.stringify({ [HERE]: { code: 'CB', name: 'CodeBär', icon: ai } }));
    await openPrefs([repo('reviewbaer')]);
    const shown = () => trigger()!.querySelector('.repo-avatar path')?.getAttribute('d');
    expect(shown()).toBe('M1 1h4');
    document.querySelector<HTMLButtonElement>('.icon-pick-b')!.click();
    await vi.waitFor(() => expect(document.querySelector('.icon-cell')).not.toBeNull());
    setValue(document.querySelector<HTMLInputElement>('.icon-panel input')!, 'hammer');
    await tick();
    button('lucide:hammer').click();
    await tick();
    expect(shown()).not.toBe('M1 1h4');
    expect(document.querySelector('.icon-pick-b')!.textContent).toBe('hammer');
    expect(JSON.parse(localStorage.getItem('codebaer.repo-icons')!)).toMatchObject({ [HERE]: { id: 'lucide:hammer' } });

    document.querySelector<HTMLButtonElement>('.icon-pick-b')!.click();
    await tick();
    button('Automatic').click();
    await tick();
    expect(shown()).toBe('M1 1h4');
    expect(JSON.parse(localStorage.getItem('codebaer.repo-icons')!)).toEqual({});
  });

  it('closes on Done', async () => {
    await openPrefs([]);
    button('Done').click();
    await tick();
    expect(S.repoPrefs).toBeNull();
    await exitTick();
    expect(dialog()).toBeNull();
  });
});

describe('the no-repo screen', () => {
  const card = () => document.querySelector<HTMLButtonElement>('.no-repo-card');

  async function mountNoRepo(): Promise<void> {
    flushSync(() => root.render(<NoRepo />));
    await tick();
  }

  it('offers the repo open last, named as the recents name it, and opens it', async () => {
    vi.mocked(c.lastRepo).mockReturnValue(HERE);
    vi.mocked(git.recentRepos).mockResolvedValue([repo('other'), { ...repo('reviewbaer', true), name: 'CodeBär' }]);
    await mountNoRepo();
    expect(card()!.querySelector('.name')!.textContent).toBe('CodeBär');
    expect(card()!.querySelector('.path')!.textContent).toBe('~/projects/reviewbaer');
    expect(card()!.querySelector('.repo-fav')).not.toBeNull();
    card()!.click();
    expect(c.openRepo).toHaveBeenCalledWith(HERE);
    document.querySelector<HTMLButtonElement>('.no-repo-pick')!.click();
    expect(c.pickRepo).toHaveBeenCalledOnce();
  });

  it('offers only a folder when no repo was open, or the last one has left the recents', async () => {
    vi.mocked(c.lastRepo).mockReturnValue(null);
    await mountNoRepo();
    expect(card()).toBeNull();
    expect(git.recentRepos).not.toHaveBeenCalled();
    vi.mocked(c.lastRepo).mockReturnValue('/Users/me/projects/gone');
    vi.mocked(git.recentRepos).mockResolvedValue([repo('other')]);
    flushSync(() => root.render(<></>));
    await mountNoRepo();
    expect(card()).toBeNull();
    expect(document.querySelector('h2')!.textContent).toBe('No repository open');
  });
});

describe('repo icons', () => {
  const asks = () => vi.mocked(git.aiRepoIcons).mock.calls.map(([items]) => items);

  it('asks the AI about the open repo, then the recents, and draws each pick in place of the code', async () => {
    setAi('claude');
    vi.mocked(git.aiRepoIcons).mockResolvedValueOnce(['lucide:bug']).mockResolvedValueOnce([null, 'lucide:globe']);
    vi.mocked(git.recentRepos).mockResolvedValue([repo('shop'), repo('site')]);
    await openRepoAt('/Users/me/projects/reviewbaer', '~/projects/reviewbaer', 'CodeBär');
    await vi.waitFor(() => expect(trigger()!.querySelector('.repo-avatar svg')).not.toBeNull());
    expect(trigger()!.querySelector('.repo-avatar')!.textContent).toBe('');
    await openMenu();
    await vi.waitFor(() => expect(row('site').querySelector('.repo-avatar svg')).not.toBeNull());
    expect(asks()).toEqual([
      [{ path: '/Users/me/projects/reviewbaer', name: 'CodeBär' }],
      [{ path: '/Users/me/projects/shop', name: 'shop' }, { path: '/Users/me/projects/site', name: 'site' }],
    ]);
    expect(row('shop').querySelector('.repo-avatar')!.textContent).toBe('SH');
  });

  it('asks about the open repo under the name the trigger shows, not the one the recents give it', async () => {
    setAi('claude');
    vi.mocked(git.aiRepoIcons).mockResolvedValue([null, null]);
    vi.mocked(git.recentRepos).mockResolvedValue([{ ...repo('twice'), name: 'Old README title' }, repo('next')]);
    await openRepoAt('/Users/me/projects/twice', '~/projects/twice', 'Twice');
    await openMenu();
    await vi.waitFor(() => expect(git.aiRepoIcons).toHaveBeenCalledTimes(2));
    expect(asks()).toEqual([
      [{ path: '/Users/me/projects/twice', name: 'Twice' }], [{ path: '/Users/me/projects/next', name: 'next' }],
    ]);
  });

  it('draws a kept icon without asking again', async () => {
    setAi('claude');
    const icon = { body: '<path d="M1 1h4"/>', width: 24, height: 24 };
    const kept = { '/Users/me/projects/kept': { code: 'KE', name: 'kept', icon } };
    localStorage.setItem('codebaer.avatars', JSON.stringify(kept));
    await openRepoAt('/Users/me/projects/kept', '~/projects/kept', null);
    expect(trigger()!.querySelector('.repo-avatar path')!.getAttribute('d')).toBe('M1 1h4');
    await tick();
    expect(git.aiRepoIcons).not.toHaveBeenCalled();
  });

  it('asks nothing while the AI is off, and asks once it is turned on', async () => {
    vi.mocked(git.aiRepoIcons).mockResolvedValue(['lucide:bug']);
    await openRepoAt('/Users/me/projects/later', '~/projects/later', null);
    await tick();
    expect(git.aiRepoIcons).not.toHaveBeenCalled();
    expect(trigger()!.querySelector('.repo-avatar')!.textContent).toBe('LA');
    setAi('claude');
    notify();
    await vi.waitFor(() => expect(trigger()!.querySelector('.repo-avatar svg')).not.toBeNull());
    expect(asks()).toEqual([[{ path: '/Users/me/projects/later', name: 'later' }]]);
  });

  it('keeps the code, without a word, when the AI fails', async () => {
    setAi('claude');
    S.toasts = [];
    vi.mocked(git.aiRepoIcons).mockRejectedValue({ kind: 'Ai', detail: 'claude CLI not found' });
    await openRepoAt('/Users/me/projects/broken', '~/projects/broken', null);
    await vi.waitFor(() => expect(git.aiRepoIcons).toHaveBeenCalledOnce());
    await tick();
    expect(trigger()!.querySelector('.repo-avatar')!.textContent).toBe('BR');
    expect(S.toasts).toEqual([]);
  });
});
