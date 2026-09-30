import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorView } from '@codemirror/view';
import { setMotion } from '#ui/motion';
import { buildState } from './editor';
import { flashLanding, ghostChunk, landingFlash } from './ghost';

async function mount(doc: string, original: string) {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const state = await buildState('unstaged', 'x.txt', doc, original, () => {}, [landingFlash],
    { accept: () => {}, reject: () => {} });
  return new EditorView({ state, parent });
}

afterEach(() => { setMotion('off'); });

describe('ghostChunk', () => {
  it('places a tinted ghost over the chunk under the cursor, and removes it once its animation ends', async () => {
    setMotion('full');
    const view = await mount('a\nB\nc\n', 'a\nb\nc\n');
    view.dispatch({ selection: { anchor: view.state.doc.line(2).from } });
    ghostChunk(view, 'accept');
    const ghost = view.scrollDOM.querySelector('.cm-ghost');
    expect(ghost?.className).toBe('cm-ghost accept');
    await Promise.resolve();
    expect(view.scrollDOM.querySelector('.cm-ghost')).toBeNull();
  });

  it('does nothing under motion off', async () => {
    const view = await mount('a\nB\nc\n', 'a\nb\nc\n');
    view.dispatch({ selection: { anchor: view.state.doc.line(2).from } });
    ghostChunk(view, 'reject');
    expect(view.scrollDOM.querySelector('.cm-ghost')).toBeNull();
  });

  it('does nothing with the cursor outside any chunk', async () => {
    setMotion('full');
    const view = await mount('a\nB\nc\nd\n', 'a\nb\nc\nd\n');
    view.dispatch({ selection: { anchor: view.state.doc.line(4).from } });
    ghostChunk(view, 'accept');
    expect(view.scrollDOM.querySelector('.cm-ghost')).toBeNull();
  });
});

describe('flashLanding', () => {
  it('marks the first line of the chunk under the cursor, then clears it after --dur-5', async () => {
    vi.useFakeTimers();
    try {
      const view = await mount('a\nB\nc\n', 'a\nb\nc\n');
      view.dispatch({ selection: { anchor: view.state.doc.line(2).from } });
      flashLanding(view);
      expect(view.dom.querySelector('.cm-landingFlash')).not.toBeNull();
      vi.advanceTimersByTime(650);
      expect(view.dom.querySelector('.cm-landingFlash')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a later flash is not cleared by an earlier one\'s stale timer', async () => {
    vi.useFakeTimers();
    try {
      const view = await mount('a\nB\nc\n', 'a\nb\nc\n');
      view.dispatch({ selection: { anchor: view.state.doc.line(2).from } });
      flashLanding(view);
      vi.advanceTimersByTime(300);
      flashLanding(view);
      vi.advanceTimersByTime(350);
      // the first flash's timer fires here; the second's still has 300ms left
      expect(view.dom.querySelector('.cm-landingFlash')).not.toBeNull();
      vi.advanceTimersByTime(300);
      expect(view.dom.querySelector('.cm-landingFlash')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a flash in a newly opened file is not cleared by the last file\'s stale timer', async () => {
    vi.useFakeTimers();
    try {
      const view = await mount('a\nB\nc\n', 'a\nb\nc\n');
      view.dispatch({ selection: { anchor: view.state.doc.line(2).from } });
      flashLanding(view);
      vi.advanceTimersByTime(300);
      // what opening another file does: a new state, with a new landingFlash field
      view.setState(await buildState('unstaged', 'y.txt', 'X\ny\n', 'x\ny\n', () => {}, [landingFlash],
        { accept: () => {}, reject: () => {} }));
      flashLanding(view);
      vi.advanceTimersByTime(350);
      expect(view.dom.querySelector('.cm-landingFlash')).not.toBeNull();
      vi.advanceTimersByTime(300);
      expect(view.dom.querySelector('.cm-landingFlash')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
