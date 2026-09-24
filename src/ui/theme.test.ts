import { beforeEach, describe, expect, it } from 'vitest';
import { getTheme, initTheme, isDark, setTheme, THEMES } from './theme';

const sheets = import.meta.glob<string>(['./themes.css', './themes/*.css'], {
  query: '?raw', import: 'default', eager: true,
});

type Block = { ids: string[]; tokens: Set<string>; scheme: string | undefined };

/** Every rule of the theme sheets that is scoped to a theme id, with the custom properties it declares. */
function blocks(): Block[] {
  const out: Block[] = [];
  for (const css of Object.values(sheets)) {
    const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const [, selector = '', body = ''] of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const ids = [...selector.matchAll(/\[data-theme="([^"]+)"\]/g)].map((m) => m[1]!);
      if (!ids.length) continue;
      const tokens = new Set([...body.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]!));
      out.push({ ids, tokens, scheme: /color-scheme:\s*(\w+)/.exec(body)?.[1] });
    }
  }
  return out;
}

beforeEach(() => {
  localStorage.removeItem('codebaer.theme');
  delete document.documentElement.dataset.theme;
});

describe('theme switch', () => {
  it('reads the CodeBär default when no attribute is set', () => {
    expect(getTheme()).toBe('codebaer');
  });

  it('setTheme writes the root attribute and localStorage', () => {
    setTheme('nord');
    expect(document.documentElement.dataset.theme).toBe('nord');
    expect(localStorage.getItem('codebaer.theme')).toBe('nord');
    expect(getTheme()).toBe('nord');
  });

  it('initTheme applies a stored value and ignores an unknown one', () => {
    localStorage.setItem('codebaer.theme', 'gruvbox-light');
    initTheme();
    expect(document.documentElement.dataset.theme).toBe('gruvbox-light');

    delete document.documentElement.dataset.theme;
    localStorage.setItem('codebaer.theme', 'solarised');
    initTheme();
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it('knows which themes are light', () => {
    expect(isDark('codebaer')).toBe(true);
    expect(isDark('dracula')).toBe(true);
    expect(isDark('github-light')).toBe(false);
    expect(isDark('rose-pine-dawn')).toBe(false);
  });
});

describe('theme sheets', () => {
  const all = blocks();
  const of = (id: string) => all.filter((b) => b.ids.includes(id));
  const reference = of('codebaer');

  it('the default block defines the full token set, terminal colours included', () => {
    expect(reference).toHaveLength(1);
    const tokens = reference[0]!.tokens;
    for (const t of ['--bg', '--text', '--accent', '--add-bg', '--syn-keyword', '--ansi-red', '--ansi-bright-white']) {
      expect(tokens, t).toContain(t);
    }
  });

  // a token a theme leaves out is not an error in CSS: it silently inherits the dark default's value
  it.each(THEMES.map((t) => [t.id, t.dark] as const))('%s defines every token of the default', (id, dark) => {
    const own = of(id);
    expect(own, `a [data-theme="${id}"] block`).toHaveLength(1);
    const missing = [...reference[0]!.tokens].filter((t) => !own[0]!.tokens.has(t));
    expect(missing).toEqual([]);
    expect(own[0]!.scheme).toBe(dark ? 'dark' : 'light');
  });

  it('has no block for a theme the catalog does not offer', () => {
    const ids = new Set<string>(THEMES.map((t) => t.id));
    expect(all.flatMap((b) => b.ids).filter((id) => !ids.has(id))).toEqual([]);
  });
});
