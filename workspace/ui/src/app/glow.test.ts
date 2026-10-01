import { describe, expect, it } from 'vitest';
import type { Info } from '#ipc/terminal';
import { S } from '#kernel/store';
import { LIGHTS } from '#ui/glow';
import { status } from '#test-app';
import { sceneFor } from './glow';

const info = (id: number, title: string, task = false): Info =>
  ({ id, title, cwd: '/', tier: 'marks', state: { t: 'Idle' }, task });

describe('glow scenes', () => {
  const animated = { ...S.settings, 'appearance.glow': 'animated' } as const;

  it('keeps one scene on every tab unless the glow is animated', () => {
    const settings = { ...S.settings, 'appearance.glow': 'on' } as const;
    const terms = { terminals: [info(1, 'claude')], activeTerm: 1 };
    const scenes = (['changes', 'files', 'terminals'] as const)
      .map((tab) => sceneFor({ ...S, ...terms, settings, tab }, new Map([[1, 350]])));
    expect(scenes[1]).toEqual(scenes[0]);
    expect(scenes[2]).toEqual(scenes[0]);
    const moved = sceneFor({ ...S, ...terms, settings: animated, tab: 'files' }, new Map());
    expect(moved).not.toEqual(scenes[0]);
  });

  it('gives every tab all seven lights', () => {
    for (const tab of ['changes', 'files', 'terminals'] as const) {
      expect(sceneFor({ ...S, settings: animated, tab }, new Map([[1, 100], [2, 170]]))).toHaveLength(LIGHTS);
    }
  });

  it('makes the changes scene fuller while there is more to review', () => {
    const empty = sceneFor({ ...S, tab: 'changes', status: null }, new Map());
    const busy = sceneFor({ ...S, tab: 'changes', status: status('a.ts') }, new Map());
    expect(busy[0]!.k).toBeGreaterThan(empty[0]!.k);
    expect(busy[0]!.r).toBeGreaterThan(empty[0]!.r);
  });

  it('puts the brightest light on the selected terminal, in its agent\'s colour, and leaves tasks out', () => {
    const scene = sceneFor({
      ...S, settings: animated, tab: 'terminals', activeTerm: 2,
      terminals: [info(1, 'zsh'), info(9, 'npm test', true), info(2, 'claude')],
    }, new Map([[1, 350], [2, 420], [7, 490]]));
    expect(scene[0]).toMatchObject({ y: '420px', color: 'var(--agent-claude)' });
    expect(Math.max(...scene.map((l) => l.k))).toBe(scene[0]!.k);
    expect(scene[1]).toMatchObject({ y: '350px', color: 'var(--accent)' });
  });

  // a closed session's tile stays in the window while it leaves, with an id no session has
  it('pairs each light with its own session\'s tile, past a tile that is leaving', () => {
    const scene = sceneFor({ ...S, settings: animated, tab: 'terminals', activeTerm: 2,
      terminals: [info(1, 'zsh'), info(2, 'claude')] },
      new Map([[1, 350], [5, 420], [2, 490]]));
    expect(scene.slice(0, 2).map((l) => l.y)).toEqual(['490px', '350px']);
  });

  it('moves the lights to the header when there is no terminal', () => {
    const scene = sceneFor({ ...S, settings: animated, tab: 'terminals', activeTerm: null, terminals: [] }, new Map());
    expect(scene.every((l) => l.y === '0%')).toBe(true);
  });
});
