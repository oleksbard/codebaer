import { describe, expect, it } from 'vitest';

const sources = import.meta.glob<string>(['/src/**/*.ts', '/src/**/*.tsx', '!/src/**/*.test.*', '!/src/mock/**'], {
  query: '?raw', import: 'default', eager: true,
});

/** Components whose own `title` prop names a dialog for assistive technology and is not passed to the DOM. */
const TITLED = new Set(['Dialog', 'AlertDialog']);

/** Blanks comments, keeping the line numbers. */
const stripComments = (code: string): string =>
  code.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

/** The tag a JSX attribute at `index` belongs to. */
function tagAt(code: string, index: number): string | undefined {
  const before = code.slice(Math.max(0, index - 600), index + 1);
  return [...before.matchAll(/<([A-Za-z][\w.]*)(?=[\s>/])/g)].pop()?.[1];
}

function nativeTitles(file: string, raw: string): string[] {
  const code = stripComments(raw);
  const lines = code.split('\n');
  const at = (index: number) => code.slice(0, index).split('\n').length;
  const hit = (index: number) => `${file}:${at(index)}: ${lines[at(index) - 1]!.trim()}`;
  const hits: string[] = [];
  for (const m of code.matchAll(/\stitle=[{"']/g)) {
    if (!TITLED.has(tagAt(code, m.index) ?? '')) hits.push(hit(m.index));
  }
  // `S.title` is the store's repo title, not a DOM node's
  for (const m of code.matchAll(/(?<!\bS)\.title\s*=(?!=)/g)) hits.push(hit(m.index));
  for (const m of code.matchAll(/setAttribute\(\s*['"]title['"]/g)) hits.push(hit(m.index));
  return hits;
}

describe('native titles', () => {
  it('are not used: a hover hint is a Tip', () => {
    const hits = Object.entries(sources).flatMap(([file, raw]) => nativeTitles(file, raw));
    expect(hits).toEqual([]);
  });

  it('are found in a tag, an assignment and a setAttribute call, and not in a dialog, the store or a comment', () => {
    const code = [
      '<button title="x" />', '<IconButton label="a" title={t} />', 'el.title = "x";', "el.setAttribute('title', 'x');",
      '<Dialog open title="Settings">', 'S.title = null;', '// <b title="x">', '/* el.title = 1 */', 'a.title == b',
    ].join('\n');
    expect(nativeTitles('f', code).map((h) => h.split(':')[1])).toEqual(['1', '2', '3', '4']);
  });
});
