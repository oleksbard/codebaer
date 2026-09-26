import { expect, test } from 'vitest';
import lib from '../../../backend/src/lib.rs?raw';
import { aiUses, register } from '#kernel/registry';
import { FEATURES } from './features';

test('every AI command lib.rs registers is declared as a feature\'s AI use, which Settings lists', () => {
  const list = /generate_handler!\[([^\]]*)\]/.exec(lib)?.[1] ?? '';
  const registered = list.split(',').map((c) => c.trim().split('::').at(-1)!).filter((c) => c.startsWith('ai_')).sort();
  expect(registered.length).toBeGreaterThan(0);
  register(FEATURES);
  expect(aiUses().map((u) => u.command).sort()).toEqual(registered);
});
