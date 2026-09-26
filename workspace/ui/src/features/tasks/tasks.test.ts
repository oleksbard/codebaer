import { describe, expect, it } from 'vitest';
import type { Info, TermState } from '#ipc/terminal';
import { outcome } from './tasks';

const task = (id: number, state: TermState = { t: 'Running', command: null, since_ms: 0 }): Info =>
  ({ id, title: 'pnpm test', cwd: '/r', tier: 'process', state, task: true });

describe('helpers', () => {
  it('reads an exit code the way a person would say it', () => {
    const at = (code: number | null) => outcome(task(1, { t: 'Exited', code }));
    expect(at(0)).toEqual({ text: 'finished', tone: 'ok' });
    expect(at(1)).toEqual({ text: 'failed with exit 1', tone: 'warn' });
    expect(at(143)?.text).toBe('stopped');
    expect(at(130)?.text).toBe('stopped');
    expect(at(null)?.text).toBe('exited');
    expect(outcome(task(1))).toBeNull();
  });
});
