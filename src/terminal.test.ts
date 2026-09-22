import { describe, expect, it, vi } from 'vitest';
import { route, watchOutput, working } from './terminal';

/** The wire shape route() expects: a little-endian session id, then pty bytes. */
function chunk(id: number, text: string): ArrayBuffer {
  const body = new TextEncoder().encode(text);
  const buf = new ArrayBuffer(4 + body.length);
  new DataView(buf).setUint32(0, id, true);
  new Uint8Array(buf, 4).set(body);
  return buf;
}

describe('a session counts as working while it keeps producing output', () => {
  it('goes quiet on its own, and reports each edge once', () => {
    vi.useFakeTimers();
    const changed = vi.fn();
    watchOutput(changed);

    route(chunk(7, 'thinking…'));
    expect(working(7)).toBe(true);
    expect(working(8)).toBe(false);

    vi.advanceTimersByTime(300);
    expect(changed).toHaveBeenCalledTimes(1);

    // a spinner keeps repainting, so the gap never grows past the window
    vi.advanceTimersByTime(400);
    route(chunk(7, 'still thinking…'));
    vi.advanceTimersByTime(400);
    expect(working(7)).toBe(true);
    expect(changed).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1000);
    expect(working(7)).toBe(false);
    expect(changed).toHaveBeenCalledTimes(2);
    // the sweep is the only thing running; a quiet app must not keep a timer alive
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });
});
