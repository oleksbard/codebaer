import { describe, expect, it } from 'vitest';
import { epoch } from './epoch';

describe('epoch', () => {
  it('keeps only the latest run current', () => {
    const e = epoch();
    const first = e.next();
    expect(first()).toBe(true);
    const second = e.next();
    expect(first()).toBe(false);
    expect(second()).toBe(true);
  });

  it('ends the current run on bump', () => {
    const e = epoch();
    const run = e.next();
    e.bump();
    expect(run()).toBe(false);
  });

  it('checks the run in progress without starting one', () => {
    const e = epoch();
    const run = e.next();
    const same = e.current();
    expect(run()).toBe(true);
    expect(same()).toBe(true);
    e.next();
    expect(same()).toBe(false);
  });
});
