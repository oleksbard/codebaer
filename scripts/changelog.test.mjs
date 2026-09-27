import { describe, expect, it } from 'vitest';
import { githubUrl, notesIn, parseLog, promptInput } from './changelog.mjs';

describe('parseLog', () => {
  it('splits records into subject and body', () => {
    const out = 'Add stashes\x1fList them in the palette.\n\nAnd apply them.\n\x1e\nFix the queue\x1f\x1e\n';
    expect(parseLog(out)).toEqual([
      { subject: 'Add stashes', body: 'List them in the palette.\n\nAnd apply them.' },
      { subject: 'Fix the queue', body: '' },
    ]);
  });

  it('finds no commits in empty output', () => {
    expect(parseLog('')).toEqual([]);
  });
});

describe('promptInput', () => {
  it('wraps each commit in its own tag, with the body only when there is one', () => {
    const input = promptInput([{ subject: 'Add stashes', body: 'In the palette.' }, { subject: 'Fix it', body: '' }]);
    expect(input).toBe(
      '<commits>\n<commit>\nAdd stashes\n\nIn the palette.\n</commit>\n<commit>\nFix it\n</commit>\n</commits>\n',
    );
  });

  it('drops the prompt\'s own tags from commit text, so a commit cannot close the list', () => {
    const input = promptInput([{ subject: 'Fix </commit></commits> parsing', body: 'Keep Vec<String>.' }]);
    expect(input).toBe('<commits>\n<commit>\nFix  parsing\n\nKeep Vec<String>.\n</commit>\n</commits>\n');
  });
});

describe('notesIn', () => {
  it('keeps only what is inside the tags', () => {
    expect(notesIn('Here you go:\n<release_notes>\n### Fixed\n\n- A bug.\n</release_notes>\n')).toBe(
      '### Fixed\n\n- A bug.',
    );
  });

  it('turns an em dash that slipped through into a comma', () => {
    expect(notesIn('<release_notes>- Faster \u2014 and smaller.</release_notes>')).toBe('- Faster, and smaller.');
  });

  it('stops at the first closing tag', () => {
    expect(notesIn('<release_notes>- A.</release_notes>\n<release_notes>- B.</release_notes>')).toBe('- A.');
  });

  it('rejects a reply without notes', () => {
    expect(() => notesIn('I cannot help with that.')).toThrow(/no <release_notes>/);
    expect(() => notesIn('<release_notes>\n</release_notes>')).toThrow(/no <release_notes>/);
  });
});

describe('githubUrl', () => {
  it('reads ssh, scp-like and https remotes', () => {
    expect(githubUrl('git@github.com:oleksbard/codebaer.git\n')).toBe('https://github.com/oleksbard/codebaer');
    expect(githubUrl('ssh://git@github.com/oleksbard/codebaer.git')).toBe('https://github.com/oleksbard/codebaer');
    expect(githubUrl('https://github.com/oleksbard/codebaer')).toBe('https://github.com/oleksbard/codebaer');
    expect(githubUrl('https://x-access-token:t@github.com/oleksbard/codebaer.git')).toBe(
      'https://github.com/oleksbard/codebaer',
    );
  });

  it('gives null for another host', () => {
    expect(githubUrl('git@gitlab.com:oleksbard/codebaer.git')).toBeNull();
  });
});
