import { expect, it, vi } from 'vitest';
import { getChunks } from '@codemirror/merge';

/** A support package that cannot be fetched, which is what a dynamic import failure looks like:
 *  a stale dev-server chunk, a bad deploy, an offline first paint. */
vi.mock('@codemirror/language-data', async () => {
  const cm = await vi.importActual<typeof import('@codemirror/language')>('@codemirror/language');
  return {
    languages: [cm.LanguageDescription.of({
      name: 'boom',
      extensions: ['boom'],
      load: () => Promise.reject(new TypeError('Importing a module script failed.')),
    })],
  };
});

const { buildState } = await import('./editor');

it('still opens a file whose language support will not load', async () => {
  const state = await buildState('unstaged', 'x.boom', 'one\ntwo\n', 'one\n2\n', () => {});

  // highlighting is decoration; losing it must cost neither the document nor the diff it is
  // opened for, which is what the whole-file "Unknown" panel used to take away
  expect(state.doc.toString()).toBe('one\ntwo\n');
  expect(getChunks(state)?.chunks.length).toBe(1);
});
