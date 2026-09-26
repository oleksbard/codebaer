import { beforeEach, describe, expect, it } from 'vitest';
import { getTheme, initTheme, isDark, setTheme, THEMES } from './theme';

const sheets = import.meta.glob<string>(['./themes.css', './themes/*.css'], {
  query: '?raw', import: 'default', eager: true,
});

type Block = { ids: string[]; tokens: Map<string, string>; scheme: string | undefined };

/** Every rule of the theme sheets that is scoped to a theme id, with the custom properties it declares. */
function blocks(): Block[] {
  const out: Block[] = [];
  for (const css of Object.values(sheets)) {
    const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const [, selector = '', body = ''] of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const ids = [...selector.matchAll(/\[data-theme="([^"]+)"\]/g)].map((m) => m[1]!);
      if (!ids.length) continue;
      const tokens = new Map([...body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));
      out.push({ ids, tokens, scheme: /color-scheme:\s*(\w+)/.exec(body)?.[1] });
    }
  }
  return out;
}

const tokensCss = Object.values(import.meta.glob<string>('./tokens.css', {
  query: '?raw', import: 'default', eager: true,
}))[0] ?? '';
const palette = new Map([...tokensCss.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));

/** Linear sRGB of a #rrggbb colour (an alpha byte is ignored), an oklch() one, or a var() naming either
 *  in tokens.css. */
function linear(value: string): [number, number, number] {
  const ref = /^var\((--[a-z0-9-]+)\)$/.exec(value);
  if (ref) return linear(palette.get(ref[1]!) ?? '');
  const ok = /^oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)$/.exec(value);
  if (ok) {
    const [L, C, h] = ok.slice(1).map(Number) as [number, number, number];
    const a = C * Math.cos((h * Math.PI) / 180);
    const b = C * Math.sin((h * Math.PI) / 180);
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
    return [
      4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
    ];
  }
  if (!/^#[0-9a-f]{6}/i.test(value)) throw new Error(`not a colour this test reads: ${value}`);
  return [1, 3, 5].map((i) => {
    const v = parseInt(value.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
}

function luminance(value: string): number {
  const [r, g, b] = linear(value).map((c) => Math.min(1, Math.max(0, c))) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const contrast = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

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
      expect([...tokens.keys()], t).toContain(t);
    }
  });

  // a token a theme leaves out is not an error in CSS: it silently inherits the dark default's value
  it.each(THEMES.map((t) => [t.id, t.dark] as const))('%s defines every token of the default', (id, dark) => {
    const own = of(id);
    expect(own, `a [data-theme="${id}"] block`).toHaveLength(1);
    const missing = [...reference[0]!.tokens.keys()].filter((t) => !own[0]!.tokens.has(t));
    expect(missing).toEqual([]);
    expect(own[0]!.scheme).toBe(dark ? 'dark' : 'light');
  });

  // a border drawn next to a --panel2 surface (a hovered row) vanishes when the two are this close; a WCAG
  // contrast ratio of 1.1 is far below what text needs, but above an edge nobody can see
  it.each(THEMES.map((t) => [t.id] as const))('%s draws --line apart from --panel2', (id) => {
    const tokens = of(id)[0]!.tokens;
    expect(contrast(tokens.get('--line')!, tokens.get('--panel2')!)).toBeGreaterThan(1.1);
  });

  it('has no block for a theme the catalog does not offer', () => {
    const ids = new Set<string>(THEMES.map((t) => t.id));
    expect(all.flatMap((b) => b.ids).filter((id) => !ids.has(id))).toEqual([]);
  });
});
