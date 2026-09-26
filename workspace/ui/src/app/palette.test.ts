import { describe, expect, it, vi } from 'vitest';
import type { Status } from '#ipc/git';

vi.mock('#ipc/git', async () => {
  const actual = await vi.importActual<typeof import('#ipc/git')>('#ipc/git');
  return { ...actual, git: Object.fromEntries(Object.keys(actual.git).map((k) => [k, vi.fn()])) };
});

const { S } = await import('#kernel/store');
const { openPalette } = await import('#kernel/registry');
await import('./bootstrap');

const status = (head: string | null): Status =>
  ({ head, branch: 'main', upstream: null, ahead: 0, behind: 0, files: [] });

async function shown(): Promise<[string, string][]> {
  const open = openPalette();
  const items = S.palette?.items.map((i): [string, string] => [i.label, i.hint ?? '']) ?? [];
  S.palette?.resolve(null);
  S.palette = null;
  await open;
  return items;
}

describe('the command palette', () => {
  it('lists every command in order, with its shortcut', async () => {
    S.status = status('abc');
    S.comments = [{
      id: 1, path: 'a.ts', side: 'work', from: 1, to: 1, anchor: 'a', quote: { t: 'code', lang: 'ts', text: 'a' },
      text: 'x', moved: false,
    }];
    S.termMenu = { shells: [{ path: '/bin/zsh', name: 'zsh' }], default: '/bin/zsh', commands: ['claude'] };
    expect(await shown()).toEqual([
      ['Git: Commit', '⌘↩'], ['Git: Push', ''], ['Git: Pull', ''], ['Git: Fetch', ''], ['Git: Checkout to…', ''],
      ['Git: Create Branch…', ''], ['Git: Stash', ''], ['Git: Pop Stash', ''],
      ['Git: Stage All Changes', '⌘⌥Y'], ['Git: Unstage All Changes', ''], ['Git: Discard All Changes', ''],
      ['Git: Stage File', '⌘⇧Y'], ['Git: Discard File', '⌘⇧N'], ['Git: Unstage File', ''],
      ['Comment on Selection', '⌘K ⌘⌥C'], ['Send Pending Comments…', ''], ['Discard Pending Comments', ''],
      ['Open Repository…', ''],
      ['Terminal: New Terminal', '⌘T'], ['Terminal: New zsh', ''], ['Terminal: Run claude', ''],
      ['Terminal: Find…', ''], ['Terminal: Find Next', ''], ['Terminal: Find Previous', ''],
      ['Terminal: Clear Buffer', ''], ['Terminal: Larger Text', ''], ['Terminal: Smaller Text', ''],
      ['Terminal: Kill Session', ''], ['Terminal: Close Session', ''],
    ]);
  });

  it('leaves out stashing on an unborn HEAD and the comment entries with nothing pending', async () => {
    S.status = status(null);
    S.comments = [];
    S.termMenu = null;
    const labels = (await shown()).map(([l]) => l);
    expect(labels).not.toContain('Git: Stash');
    expect(labels).not.toContain('Git: Pop Stash');
    expect(labels).not.toContain('Send Pending Comments…');
    expect(labels).toContain('Git: Create Branch…');
  });
});
