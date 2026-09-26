import { describe, expect, it } from 'vitest';
import type { CustomCommand } from '#ipc/settings';
import { commandGroups, inMenu, scriptHidden } from './commands';

const cmd = (command: string, repo: string | null): CustomCommand =>
  ({ name: '', command, repo, hide_terminal: false, icon: null });

describe('saved commands', () => {
  it('offers the global commands and this repo\'s, never another repo\'s', () => {
    expect([cmd('a', null), cmd('b', '/r'), cmd('c', '/other')].filter((x) => inMenu(x, '/r')).map((x) => x.command))
      .toEqual(['a', 'b']);
    expect(inMenu(cmd('b', '/r'), null)).toBe(false);
  });

  it('groups this repo, then global, then the rest in order, with the first two always present', () => {
    const all = [cmd('x', '/b'), cmd('g', null), cmd('y', '/a'), cmd('z', '/b')];
    expect(commandGroups(all, '/r').map((g) => [g.repo, g.commands.map((x) => x.command)])).toEqual([
      ['/r', []], [null, ['g']], ['/b', ['x', 'z']], ['/a', ['y']],
    ]);
    expect(commandGroups([], null).map((g) => g.repo)).toEqual([null]);
  });

  it('hides a script only in the repo it was hidden in', () => {
    const hidden = { '/r': ['dev'] };
    expect(scriptHidden(hidden, '/r', 'dev')).toBe(true);
    expect(scriptHidden(hidden, '/r', 'test')).toBe(false);
    expect(scriptHidden(hidden, '/other', 'dev')).toBe(false);
    expect(scriptHidden(hidden, null, 'dev')).toBe(false);
  });
});
