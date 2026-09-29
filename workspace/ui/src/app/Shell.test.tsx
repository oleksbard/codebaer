import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { tick } from '#test-setup';
import { g, mountApp, status } from '#test-app';

vi.mock('#ipc/git', async () => {
  const actual = await vi.importActual<typeof import('#ipc/git')>('#ipc/git');
  return {
    ...actual,
    git: Object.fromEntries(Object.keys(actual.git).map((k) => [k, vi.fn()])),
  };
});
vi.mock('#kernel/dialogs', async () => {
  const actual = await vi.importActual<typeof import('#kernel/dialogs')>('#kernel/dialogs');
  return { ...actual, confirmDialog: vi.fn() };
});
vi.mock('#ipc/terminal', async () => {
  const actual = await vi.importActual<typeof import('#ipc/terminal')>('#ipc/terminal');
  return { ...actual, checkCwd: vi.fn() };
});

const { confirmDialog } = await import('#kernel/dialogs');
const confirmMock = confirmDialog as unknown as ReturnType<typeof vi.fn>;

let S: typeof import('#kernel/store').S;

beforeAll(async () => {
  await mountApp();
  S = (await import('#kernel/store')).S;
});

beforeEach(() => {
  for (const fn of Object.values(g)) fn.mockReset().mockResolvedValue(undefined);
  confirmMock.mockReset().mockResolvedValue(false);
  S.open = null;
  S.selected = null;
  S.flushing = null;
  S.status = status('a.txt');
});

describe('sidebar resize', () => {
  // jsdom drives requestAnimationFrame off its own ~16ms clock, which no tick() can wait for
  const raf = globalThis.requestAnimationFrame;
  const caf = globalThis.cancelAnimationFrame;
  // jsdom lays nothing out: the sidebar's left edge is 0, so clientX is the width, and the
  // frame is given the width layout would have
  const frameWidth = 1000;
  const maxWidth = frameWidth - 400;
  beforeAll(() => {
    globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(0));
    globalThis.cancelAnimationFrame = (h) => clearTimeout(h);
    const frame = document.querySelector('.frame')!;
    Object.defineProperty(frame, 'clientWidth', { value: frameWidth, configurable: true });
  });
  afterAll(() => {
    globalThis.requestAnimationFrame = raf;
    globalThis.cancelAnimationFrame = caf;
    delete (document.querySelector('.frame') as { clientWidth?: number } | null)?.clientWidth;
  });

  it('follows the pointer between 180px and the frame width less 400px, and stores the width on release',
    async () => {
    const gutter = document.getElementById('gutter')!;
    const shell = document.getElementById('shell')!;
    const ev = (kind: string, clientX = 0) =>
      gutter.dispatchEvent(new PointerEvent(kind, { pointerId: 1, clientX, bubbles: true }));
    ev('pointerdown', 272);
    ev('pointermove', 340);
    await tick();
    expect(shell.style.getPropertyValue('--side-w')).toBe('340px');
    ev('pointermove', 20);
    await tick();
    expect(shell.style.getPropertyValue('--side-w')).toBe('180px');
    ev('pointermove', 5000);
    await tick();
    expect(shell.style.getPropertyValue('--side-w')).toBe(`${maxWidth}px`);
    ev('pointerup');
    expect(localStorage.getItem('codebaer.sideWidth')).toBe(String(maxWidth));
    ev('pointermove', 300);
    await tick();
    expect(shell.style.getPropertyValue('--side-w')).toBe(`${maxWidth}px`);
  });

  it('coalesces the moves inside one frame into a single render of the last width', async () => {
    const { subscribe } = await import('#kernel/store');
    const gutter = document.getElementById('gutter')!;
    const shell = document.getElementById('shell')!;
    const ev = (kind: string, clientX = 0) =>
      gutter.dispatchEvent(new PointerEvent(kind, { pointerId: 1, clientX, bubbles: true }));
    let notifies = 0;
    const off = subscribe(() => { notifies++; });
    ev('pointerdown', 272);
    ev('pointermove', 300);
    ev('pointermove', 420);
    await tick();
    off();

    expect(notifies).toBe(1);
    expect(shell.style.getPropertyValue('--side-w')).toBe('420px');
    ev('pointerup');
    expect(localStorage.getItem('codebaer.sideWidth')).toBe('420');
  });
});


describe('sidebar handle', () => {
  const handle = () => document.querySelector<HTMLButtonElement>('.side-handle')!;
  afterEach(async () => {
    const { notify } = await import('#kernel/store');
    S.sideCollapsed = false;
    localStorage.removeItem('codebaer.sideCollapsed');
    notify();
    await tick();
  });

  it('collapses the sidebar and expands it again, and stores the choice', async () => {
    const shell = document.getElementById('shell')!;
    handle().click();
    await tick();
    expect(shell.classList).toContain('sidecollapsed');
    expect(handle().getAttribute('aria-label')).toBe('Expand sidebar');
    expect(handle().getAttribute('aria-expanded')).toBe('false');
    expect(localStorage.getItem('codebaer.sideCollapsed')).toBe('true');

    handle().click();
    await tick();
    expect(shell.classList).not.toContain('sidecollapsed');
    expect(handle().getAttribute('aria-label')).toBe('Collapse sidebar');
    expect(localStorage.getItem('codebaer.sideCollapsed')).toBe('false');
  });

  it('expands before a command focuses the list or the commit box inside it', async () => {
    const { run } = await import('#kernel/registry');
    const { refs } = await import('#kernel/store');
    const cases = [['app.focusList', () => refs.list], ['git.focusCommit', () => refs.commit]] as const;
    for (const [command, target] of cases) {
      handle().click();
      await tick();
      expect(S.sideCollapsed).toBe(true);
      run(command);
      await tick();
      expect(S.sideCollapsed).toBe(false);
      expect(document.activeElement).toBe(target());
    }
  });
});
