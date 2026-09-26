import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { tick } from '#test-setup';
import type { FileEntry, Status } from '#ipc/git';
import type { Row } from '#core/model';

vi.mock('./actions', () => ({ setTab: vi.fn() }));
vi.mock('#kernel/clipboard', () => {
  const copyPath = vi.fn();
  return {
    copyPath, copyItem: (path: string) => ({ label: 'Copy relative path', onSelect: () => void copyPath(path) }),
  };
});
vi.mock('#core/session', () => ({ openRow: vi.fn(), openPlain: vi.fn() }));
vi.mock('#features/orphans', async () => ({
  ...(await vi.importActual<object>('#features/orphans')), findOrphans: vi.fn(),
}));
vi.mock('#features/settings', async () => ({
  ...(await vi.importActual<object>('#features/settings')), openSettings: vi.fn(),
}));

const c = await import('./actions');
const { S, notify } = await import('#kernel/store');
const { ActivityBar, Sidebar } = await import('./Sidebar');
const h = {
  ...c, ...(await import('#core/session')), findOrphans: (await import('#features/orphans')).findOrphans,
  openSettings: (await import('#features/settings')).openSettings,
  copyPath: (await import('#kernel/clipboard')).copyPath,
} as unknown as Record<string, ReturnType<typeof vi.fn>>;

/** Builds the Status whose buildQueue() yields exactly these rows. */
function statusFor(unstaged: Row[], staged: Row[]): Status {
  const files = new Map<string, FileEntry>();
  const blank = { indexStatus: '.', worktreeStatus: '.', untracked: false, conflicted: false } as const;
  const get = (p: string) => files.get(p) ?? files.set(p, { path: p, ...blank }).get(p)!;
  for (const r of unstaged) {
    const f = get(r.path);
    if (r.conflicted) f.conflicted = true;
    else if (r.untracked) f.untracked = true;
    else f.worktreeStatus = r.letter;
  }
  for (const r of staged) get(r.path).indexStatus = r.letter;
  return { head: 'abc', branch: 'main', upstream: null, ahead: 0, behind: 0, files: [...files.values()] };
}

let root: Root;
let side: HTMLElement;

beforeEach(() => {
  for (const fn of Object.values(h)) fn.mockReset();
  document.body.innerHTML = '<div id="host"></div>';
  S.status = null; S.files = []; S.tab = 'changes'; S.selected = null; S.open = null;
  S.filesOpen = new Set(); S.aiBusy = false; S.committing = false; S.commitMessage = ''; S.ignored = [];
  S.ignoredKids = new Map(); S.settings = { ...S.settings, 'general.headless-ai-provider': 'claude' };
  root = createRoot(document.getElementById('host')!);
  flushSync(() => root.render(<Sidebar />));
  side = document.querySelector<HTMLElement>('.side')!;
});

afterEach(() => {
  root.unmount();
  document.body.innerHTML = '';
});

async function render(unstaged: Row[], staged: Row[] = [], selected: string | null = null): Promise<void> {
  S.status = statusFor(unstaged, staged);
  S.selected = selected;
  S.tab = 'changes';
  notify();
  await tick();
}

describe('brand menu', () => {
  it('opens Settings from its first item', async () => {
    const host = document.body.appendChild(document.createElement('div'));
    const bar = createRoot(host);
    flushSync(() => bar.render(<ActivityBar />));
    host.querySelector<HTMLButtonElement>('.brand')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await tick();
    const items = [...document.querySelectorAll<HTMLElement>('.menu-item')];
    expect(items.map((i) => i.textContent)).toEqual(['Settings…⌘,', 'Terminals and Orphans…']);
    items[0]!.click();
    expect(h.openSettings).toHaveBeenCalledTimes(1);
    bar.unmount();
  });
});

describe('repo switcher', () => {
  it('lives in the header, not the sidebar', async () => {
    S.root = '/Users/me/projects/reviewbaer';
    await render([]);
    expect(side.querySelector('.repo-trigger')).toBeNull();
    S.root = null;
  });
});
