import { expect, it } from 'vitest';
import { highlightLines } from './snippet';

const text = (lines: { text: string }[][]): string[] => lines.map((l) => l.map((t) => t.text).join(''));

it('highlights the lines it is asked for, read in the context of the lines above them', async () => {
  const src = 'const a = 1;\nconst s = `one\ntwo`;\nlet b = 2;\n';

  const lines = await highlightLines('x.ts', src, 3, 4);

  expect(text(lines)).toEqual(['two`;', 'let b = 2;']);
  // inside the template string that line 2 opened, so a string, not a name
  const two = lines[0]![0]!;
  const name = lines[1]!.find((t) => t.text === 'b')!;
  expect(two.cls).not.toBe('');
  expect(two.cls).not.toBe(name.cls);
  expect(lines[1]!.find((t) => t.text === 'let')!.cls).not.toBe('');
});

it('clamps the range to the file, and gives a file it has no language for as plain text', async () => {
  expect(await highlightLines('notes.unknown', 'one\ntwo', 0, 9)).toEqual([
    [{ text: 'one', cls: '' }], [{ text: 'two', cls: '' }],
  ]);
  expect(await highlightLines('notes.unknown', 'one\ntwo', 5, 9)).toEqual([[{ text: 'two', cls: '' }]]);
});
