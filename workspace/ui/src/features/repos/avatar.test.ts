import { beforeEach, describe, expect, it } from 'vitest';
import {
  avatars, candidates, forgetAvatars, hasAvatarIcon, HUES, hueOf, keepPickedIcon, pickedIcon, setAvatarIcon, words,
  type Avatar,
} from './avatar';

const KEY = 'codebaer.avatars';
const first = (name: string, n: number) => [...candidates(name)].slice(0, n);
const repo = (path: string, name: string) => ({ path, name });
const seed = (v: unknown) => { localStorage.setItem(KEY, JSON.stringify(v)); };
const codes = (got: Map<string, Avatar>) => [...got].map(([path, a]) => [path, a.code]);
const icon = { body: '<path d="M1 1h4"/>', width: 24, height: 24 };

beforeEach(() => {
  localStorage.removeItem(KEY);
  localStorage.removeItem('codebaer.repo-icons');
});

describe('words', () => {
  it.each([
    ['bunch-platform', ['bunch', 'platform']],
    ['CodeBär', ['Code', 'Bar']],
    ['HTTPServer', ['HTTP', 'Server']],
    ['my_cool.app v2', ['my', 'cool', 'app', 'v', '2']],
    ['project2', ['project', '2']],
    ['@acme/web-ui', ['web', 'ui']],
    ['🦫 CodeBär', ['Code', 'Bar']],
    ['Київ', ['Київ']],
    ['हिंदी ऐप', ['हिंदी', 'ऐप']],
    ['🚀', []],
  ])('%s -> %j', (name, expected) => {
    expect(words(name)).toEqual(expected);
  });
});

describe('candidates', () => {
  it('starts with word initials, then the later words, where same-prefix names differ', () => {
    expect(first('bunch-platform', 2)).toEqual(['BP', 'BL']);
    expect(first('bunch-portal', 2)).toEqual(['BP', 'BO']);
    expect(first('my-cool-app', 6)).toEqual(['MC', 'MA', 'MO', 'ML', 'MP', 'MY']);
  });

  it('keeps the first letter and tries later consonants before vowels', () => {
    expect(first('reviewbaer', 8)).toEqual(['RE', 'RV', 'RW', 'RB', 'RR', 'RI', 'RA', 'RC']);
    expect(first('CodeBär', 6)).toEqual(['CB', 'CA', 'CR', 'CO', 'CD', 'CE']);
  });

  it('pairs a digit word like any other', () => {
    expect(first('project2', 1)).toEqual(['P2']);
  });

  it('keeps non-Latin letters, a whole character with its marks at a time', () => {
    expect(first('Київ', 1)).toEqual(['КИ']);
    expect(first('हिंदी', 1)).toEqual(['हिंदी']);
  });

  it('never runs out, and every candidate is two characters', () => {
    const all = [...candidates('x')];
    expect(new Set(all).size).toBe(all.length);
    expect(all).toContain('ZZ');
    expect(all).toContain('09');
    expect(all.every((c) => c.length === 2)).toBe(true);
    expect([...candidates('straße')].every((c) => c.length === 2)).toBe(true);
  });

  it('falls back to plain pairs for a name without letters', () => {
    expect(first('🚀', 2)).toEqual(['AA', 'AB']);
  });
});

describe('avatars', () => {
  it('gives each repo its first free candidate, in display order', () => {
    const got = avatars([repo('/a', 'reviewbaer'), repo('/b', 'reviewbaer')]);
    expect(codes(got)).toEqual([['/a', 'RE'], ['/b', 'RV']]);
    const more = avatars([repo('/c', 'bunch-platform'), repo('/d', 'bunch-portal')]);
    expect(codes(more)).toEqual([['/c', 'BP'], ['/d', 'BO']]);
  });

  it('keeps a repo on its code when the order changes', () => {
    avatars([repo('/a', 'reviewbaer'), repo('/b', 'reviewbaer')]);
    const got = avatars([repo('/b', 'reviewbaer'), repo('/a', 'reviewbaer')]);
    expect(got.get('/a')?.code).toBe('RE');
    expect(got.get('/b')?.code).toBe('RV');
  });

  it('keeps a code reserved for a known repo that is not in the list', () => {
    avatars([repo('/a', 'reviewbaer')]);
    expect(avatars([repo('/b', 'reviewbaer')]).get('/b')?.code).toBe('RV');
    expect(avatars([repo('/a', 'reviewbaer')]).get('/a')?.code).toBe('RE');
  });

  it('picks a new code when the repo name changed', () => {
    seed({ '/a': { code: 'XY', name: 'old name' } });
    expect(avatars([repo('/a', 'reviewbaer')]).get('/a')?.code).toBe('RE');
  });

  it('lets the first repo keep a code that two stored entries claim', () => {
    seed({ '/a': { code: 'RE', name: 'reviewbaer' }, '/b': { code: 'RE', name: 'reviewbaer' } });
    const got = avatars([repo('/a', 'reviewbaer'), repo('/b', 'reviewbaer')]);
    expect(codes(got)).toEqual([['/a', 'RE'], ['/b', 'RV']]);
  });

  it('lists a path given twice once, under its first name', () => {
    seed({ '/a': { code: 'XY', name: 'old name' } });
    expect(codes(avatars([repo('/a', 'reviewbaer'), repo('/a', 'old name')]))).toEqual([['/a', 'RE']]);
  });

  it('treats unreadable storage as empty', () => {
    localStorage.setItem(KEY, '{not json');
    expect(avatars([repo('/a', 'reviewbaer')]).get('/a')?.code).toBe('RE');
    seed({ '/b': { code: 'RE' }, '/c': 'RE', '/d': { code: 'RE', name: 1 }, '/f': { code: 'REVIEW', name: 'x' } });
    expect(avatars([repo('/e', 'reviewbaer')]).get('/e')?.code).toBe('RE');
    seed({ '/a': { code: 'HELLO', name: 'reviewbaer' } });
    expect(avatars([repo('/a', 'reviewbaer')]).get('/a')?.code).toBe('RE');
  });
});

describe('avatar icons', () => {
  it('go on the repo of the name they were picked for, and stay with it in any order', () => {
    avatars([repo('/a', 'reviewbaer'), repo('/b', 'reviewbaer')]);
    expect(hasAvatarIcon(repo('/b', 'reviewbaer'))).toBe(false);
    setAvatarIcon(repo('/b', 'reviewbaer'), icon);
    setAvatarIcon(repo('/a', 'renamed'), icon);
    setAvatarIcon(repo('/c', 'reviewbaer'), icon);
    expect(hasAvatarIcon(repo('/b', 'reviewbaer'))).toBe(true);
    expect([...avatars([repo('/b', 'reviewbaer'), repo('/a', 'reviewbaer')])]).toEqual([
      ['/b', { code: 'RV', icon }], ['/a', { code: 'RE', icon: null }],
    ]);
  });

  it('stay when a repo gives up its code, and go when its name changes', () => {
    seed({ '/a': { code: 'RE', name: 'reviewbaer' }, '/b': { code: 'RE', name: 'reviewbaer', icon } });
    expect(avatars([repo('/a', 'reviewbaer'), repo('/b', 'reviewbaer')]).get('/b')).toEqual({ code: 'RV', icon });
    expect(avatars([repo('/b', 'codebaer')]).get('/b')).toEqual({ code: 'CO', icon: null });
    expect(hasAvatarIcon(repo('/b', 'reviewbaer'))).toBe(false);
  });

  it('drops an unreadable icon and keeps the code', () => {
    for (const bad of [{ body: 1, width: 24, height: 24 }, { body: '<path/>', width: '24', height: 24 }, 'x', null]) {
      seed({ '/a': { code: 'XY', name: 'reviewbaer', icon: bad } });
      expect(avatars([repo('/a', 'reviewbaer')]).get('/a'), JSON.stringify(bad)).toEqual({ code: 'XY', icon: null });
    }
  });
});

describe('picked icons', () => {
  const hammer = { id: 'lucide:hammer', body: '<path d="M2 2h8"/>', width: 24, height: 24 };

  it('draw over the AI\'s icon, and survive a rename and the repo leaving the recents', () => {
    seed({ '/a': { code: 'RE', name: 'reviewbaer', icon } });
    keepPickedIcon('/a', hammer);
    const { id: _, ...drawn } = hammer;
    expect(avatars([repo('/a', 'reviewbaer')]).get('/a')).toEqual({ code: 'RE', icon: drawn });
    forgetAvatars([]);
    expect(avatars([repo('/a', 'codebaer')]).get('/a')).toEqual({ code: 'CO', icon: drawn });
    expect(pickedIcon('/a')).toEqual(hammer);
  });

  it('give way to the AI\'s icon once cleared, and leave other repos\' picks alone', () => {
    seed({ '/a': { code: 'RE', name: 'reviewbaer', icon } });
    keepPickedIcon('/a', hammer);
    keepPickedIcon('/b', hammer);
    keepPickedIcon('/a', null);
    expect(avatars([repo('/a', 'reviewbaer')]).get('/a')).toEqual({ code: 'RE', icon });
    expect(pickedIcon('/b')).toEqual(hammer);
  });

  it('drop an entry that is not a whole pick', () => {
    const idless = { body: '<path/>', width: 24, height: 24 };
    localStorage.setItem('codebaer.repo-icons', JSON.stringify({ '/a': idless, '/b': 'x' }));
    expect([pickedIcon('/a'), pickedIcon('/b')]).toEqual([null, null]);
  });
});

describe('forgetAvatars', () => {
  it('frees the codes of repos that are no longer kept', () => {
    avatars([repo('/a', 'reviewbaer'), repo('/b', 'reviewbaer')]);
    forgetAvatars(['/b']);
    expect(avatars([repo('/c', 'reviewbaer')]).get('/c')?.code).toBe('RE');
    expect(avatars([repo('/b', 'reviewbaer')]).get('/b')?.code).toBe('RV');
  });
});

describe('hueOf', () => {
  it('is stable per path and spreads across the palette', () => {
    expect(hueOf('/a/b')).toBe(hueOf('/a/b'));
    const seen = new Set(Array.from({ length: 30 }, (_, i) => hueOf(`/Users/me/projects/repo${i}`)));
    expect([...seen].every((h) => HUES.includes(h))).toBe(true);
    expect(seen.size).toBeGreaterThan(3);
  });
});
