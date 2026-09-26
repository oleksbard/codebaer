import { describe, expect, it } from 'vitest';
import {
  eligible, fence, format, langOf, locate, location, pastePayload, reanchor, sanitize, takesComments, type Comment,
} from './comments';
import type { Info } from '#ipc/terminal';

const comment = (over: Partial<Comment> = {}): Comment => ({
  id: 1, path: 'src/a.ts', side: 'work', from: 3, to: 4, anchor: 'x\ny',
  quote: { t: 'code', lang: 'ts', text: 'x\ny' }, text: 'Fix this.', moved: false, ...over,
});

const session = (id: number, title: string, over: Partial<Info> = {}): Info =>
  ({ id, title, cwd: '/r', tier: 'marks', state: { t: 'Idle' }, ...over });

describe('location', () => {
  it('writes one line bare, a range with a dash, and marks the staged side', () => {
    expect(location(comment({ from: 7, to: 7 }))).toBe('src/a.ts:7');
    expect(location(comment())).toBe('src/a.ts:3-4');
    expect(location(comment({ side: 'index' }))).toBe('src/a.ts:3-4 (staged)');
  });
});

describe('langOf', () => {
  it.each([
    ['src/app/Main.tsx', 'tsx'], ['Cargo.TOML', 'toml'], ['Makefile', ''], ['.gitignore', ''], ['a.b/c', ''],
  ])('%s -> %j', (path, lang) => {
    expect(langOf(path)).toBe(lang);
  });
});

describe('fence', () => {
  it('is three backticks, or one more than the longest run inside', () => {
    expect(fence('plain')).toBe('```');
    expect(fence('a ``` b ```` c')).toBe('`````');
  });
});

describe('format', () => {
  it('sends one comment as location, fenced quote, then the text', () => {
    expect(format([comment()])).toBe('src/a.ts:3-4\n```ts\nx\ny\n```\nFix this.');
  });

  it('numbers a batch under a heading, sorted by path then line', () => {
    const out = format([
      comment({ id: 1, path: 'src/b.ts', from: 1, to: 1, text: 'B' }),
      comment({ id: 2, path: 'src/a.ts', from: 9, to: 9, text: 'A9' }),
      comment({ id: 3, path: 'src/a.ts', from: 2, to: 2, text: 'A2', quote: { t: 'diff', text: '-old\n+new' } }),
    ]);
    expect(out).toBe([
      'Review comments:',
      '1. src/a.ts:2\n```diff\n-old\n+new\n```\nA2',
      '2. src/a.ts:9\n```ts\nx\ny\n```\nA9',
      '3. src/b.ts:1\n```ts\nx\ny\n```\nB',
    ].join('\n\n'));
  });

  it('clips a very long line without splitting a character, and drops a lone surrogate', () => {
    const out = format([comment({ quote: { t: 'code', lang: '', text: 'x'.repeat(5000) } })]);
    expect(out).toContain(`\n${'x'.repeat(400)}…\n`);
    const emoji = format([comment({ quote: { t: 'code', lang: '', text: `${'x'.repeat(399)}${'😀'.repeat(10)}` } })]);
    expect(emoji).toContain(`\n${'x'.repeat(399)}😀…\n`);
    expect(sanitize('a\ud83db')).toBe('ab');
  });

  it('cuts a long quote at 30 lines and says how many were left out, outside the fence', () => {
    const text = Array.from({ length: 42 }, (_, i) => `l${i + 1}`).join('\n');
    const out = format([comment({ quote: { t: 'code', lang: '', text } })]);
    expect(out).toContain('l30\n```\n(12 more lines not shown)\nFix this.');
    expect(out).not.toContain('l31');
  });
});

describe('sanitize and the paste payload', () => {
  it('removes a paste terminator and every control but tab and newline', () => {
    expect(sanitize('a\x1b[201~b\tc\x07d\x7fe\u009bf')).toBe('a[201~b\tcdef');
    expect(sanitize('one\r\ntwo\rthree')).toBe('one\ntwo\nthree');
  });

  it('wraps the text in bracketed paste markers with CR newlines', () => {
    expect(pastePayload('a\nb\x1b')).toBe('\x1b[200~a\rb\x1b[201~');
  });
});

describe('which terminals take comments', () => {
  it('offers only live agent sessions inside the repo', () => {
    const all = [
      session(1, 'zsh'),
      session(2, 'claude', { cwd: '/r/sub' }),
      session(3, 'claude', { cwd: '/elsewhere' }),
      session(4, 'claude', { state: { t: 'Exited', code: 1 } }),
      session(5, 'codex'),
    ];
    expect(eligible(all, '/r').map((s) => s.id)).toEqual([2, 5]);
    expect(eligible(all, null)).toEqual([]);
  });

  it('never takes comments in a shell, or in a one-shot agent run a shell would read after', () => {
    const running = (command: string | null) => ({ state: { t: 'Running', command, since_ms: 0 } as const });
    for (const title of ['zsh', 'fish', 'bash', 'dash']) expect(takesComments(session(1, title))).toBe(false);
    expect(takesComments(session(2, 'zsh', running('python3')))).toBe(false);
    expect(takesComments(session(3, 'claude', running(null)))).toBe(true);
    expect(takesComments(session(4, 'bash', running('claude --resume')))).toBe(true);
    for (const command of [
      'claude -p "fix it"', 'claude --print x', 'claude --print=true x', 'claude mcp list', 'claude update',
      'codex exec fix', 'codex e fix', '/opt/homebrew/bin/codex exec fix', 'Codex exec', 'codex -c model=o3 exec fix',
      'codex login', 'codex apply', 'claude -pc "x"', 'claude "-p" "fix it"', 'codex "exec" x', 'claude < prompt.txt',
      'claude &', 'claude | tee log', 'FOO=1 claude -p x', 'codex \\  exec "x"', 'claude \\  mcp serve',
      'claude upgrade', 'claude ultrareview', 'claude auth login', 'codex review', 'codex --add-dir ../lib exec "x"',
      'codex --enable feat exec "x"', 'claude $(cat args)', 'claude "x"<prompt.txt', 'claude "x">out',
      "claude 'x'|cat", 'claude "x";ls', 'claude "x"&&python3', 'codex resume && python3', 'codex resume < /dev/null',
      'codex resume --last > log', 'codex resume | tee log', 'codex resume $(foo)', 'claude -r -p "x"',
      'claude --resume --print "x"', "claude $'-p' \"q\"", 'claude "x"python3',
    ]) {
      expect([command, takesComments(session(5, 'zsh', running(command)))]).toEqual([command, false]);
    }
    for (const command of [
      'claude', 'claude --resume', 'codex -p work', 'codex resume', '/usr/local/bin/claude -c',
      'codex "add a test for login"', 'claude "please update the docs"', "claude 'fix the mcp config loader'",
      'codex --profile a', 'claude --add-dir config', 'ANTHROPIC_MODEL=x claude', '  claude',
      'FOO="a b" claude', 'claude --append-system-prompt update', 'claude --resume abc', 'codex resume --last',
      'claude --model=opus "fix it"', 'claude -w feat', 'claude --worktree feat', 'claude --from-pr 12',
      'claude --debug api', 'codex resume abc123', 'claude -r', 'claude --resume abc -c',
    ]) {
      expect([command, takesComments(session(6, 'zsh', running(command)))]).toEqual([command, true]);
    }
  });
});

describe('re-anchoring', () => {
  const lines = ['a', 'x', 'y', 'b', 'x', 'y', 'c'];

  it('finds the occurrence nearest the old line', () => {
    expect(reanchor(lines, 'x\ny', 1)).toBe(2);
    expect(reanchor(lines, 'x\ny', 6)).toBe(5);
    expect(reanchor(lines, 'nope', 1)).toBeNull();
  });

  it('keeps a range whose anchor still matches and moves one that does not', () => {
    expect(locate(lines, { from: 5, to: 6, anchor: 'x\ny' })).toEqual({ from: 5, to: 6 });
    expect(locate(lines, { from: 6, to: 7, anchor: 'x\ny' })).toEqual({ from: 5, to: 6 });
    expect(locate(lines, { from: 1, to: 1, anchor: 'gone' })).toBeNull();
  });
});
