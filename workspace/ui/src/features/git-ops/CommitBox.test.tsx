import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { tick } from '#test-setup';
import type { FileEntry, Status } from '#ipc/git';
import type { Row } from '#core/model';

vi.mock('./git-ops', async () => ({
  ...(await vi.importActual<object>('./git-ops')), aiMessage: vi.fn(), commit: vi.fn(),
}));

const { S, notify } = await import('#kernel/store');
const { Sidebar } = await import('#app/Sidebar');
const ops = await import('./git-ops');
const h = { aiMessage: ops.aiMessage, commit: ops.commit } as unknown as Record<string, ReturnType<typeof vi.fn>>;

const row = (path: string, letter: string, section: Row['section'] = 'unstaged', extra: Partial<Row> = {}): Row =>
  ({ section, path, letter, untracked: false, conflicted: false, ...extra });

/** Builds the Status whose buildQueue() yields exactly these rows. */
function statusFor(unstaged: Row[], staged: Row[]): Status {
  const files = new Map<string, FileEntry>();
  const blank = { indexStatus: '.', worktreeStatus: '.', untracked: false, conflicted: false } as const;
  const get = (p: string) => files.get(p) ?? files.set(p, { path: p, ...blank }).get(p)!;
  for (const r of unstaged) {
    const f = get(r.path);
    if (r.conflicted) f.conflicted = true;
    else if (r.untracked) f.untracked = true;
    else f.worktreeStatus = r.letter;
  }
  for (const r of staged) get(r.path).indexStatus = r.letter;
  return { head: 'abc', branch: 'main', upstream: null, ahead: 0, behind: 0, files: [...files.values()] };
}

let root: Root;
let side: HTMLElement;

beforeEach(() => {
  for (const fn of Object.values(h)) fn.mockReset();
  document.body.innerHTML = '<div id="host"></div>';
  S.status = null; S.files = []; S.tab = 'changes'; S.selected = null; S.open = null;
  S.filesOpen = new Set(); S.aiBusy = false; S.committing = false; S.commitMessage = ''; S.ignored = [];
  S.ignoredKids = new Map(); S.settings = { ...S.settings, 'general.headless-ai-provider': 'claude' };
  root = createRoot(document.getElementById('host')!);
  flushSync(() => root.render(<Sidebar />));
  side = document.querySelector<HTMLElement>('.side')!;
});

afterEach(() => {
  root.unmount();
  document.body.innerHTML = '';
});

async function render(unstaged: Row[], staged: Row[] = [], selected: string | null = null): Promise<void> {
  S.status = statusFor(unstaged, staged);
  S.selected = selected;
  S.tab = 'changes';
  notify();
  await tick();
}

describe('commit button', () => {
  const btn = () => side.querySelector<HTMLButtonElement>('#commit-btn')!;

  it('stays disabled until the message box holds more than whitespace', async () => {
    await render([], [row('a.ts', 'M', 'staged')]);
    expect(btn().disabled).toBe(true);
    S.commitMessage = '   '; notify(); await tick();
    expect(btn().disabled).toBe(true);
    S.commitMessage = 'Fix the thing'; notify(); await tick();
    expect(btn().disabled).toBe(false);
  });

  it('swaps to a spinner while committing and refuses a second click', async () => {
    await render([], [row('a.ts', 'M', 'staged')]);
    S.commitMessage = 'Fix the thing'; notify(); await tick();
    expect(btn().textContent).toBe('Commit ⌘↩');
    expect(btn().disabled).toBe(false);

    S.committing = true; notify(); await tick();
    expect(btn().disabled).toBe(true);
    expect(btn().classList.contains('busy')).toBe(true);
    expect(btn().textContent).toBe('Committing…');
    expect(btn().querySelector('.spinner')).not.toBeNull();

    S.committing = false; notify(); await tick();
    expect(btn().textContent).toBe('Commit ⌘↩');
    expect(btn().disabled).toBe(false);
  });
});

describe('AI commit message button', () => {
  const btn = () => side.querySelector<HTMLButtonElement>('#ai-btn')!;

  it('is disabled with nothing staged and enabled once something is', async () => {
    await render([]);
    expect(btn().disabled).toBe(true);
    await render([], [row('a.ts', 'M', 'staged')]);
    expect(btn().disabled).toBe(false);
  });

  it('click asks for a message, busy disables it, the store fills the box', async () => {
    await render([], [row('a.ts', 'M', 'staged')]);
    btn().click();
    expect(h.aiMessage).toHaveBeenCalledTimes(1);
    S.aiBusy = true; notify(); await tick();
    expect(btn().disabled).toBe(true);
    expect(btn().classList.contains('busy')).toBe(true);
    S.aiBusy = false; notify(); await tick();
    expect(btn().disabled).toBe(false);
    expect(btn().classList.contains('busy')).toBe(false);
    S.commitMessage = 'Fix the thing'; notify(); await tick();
    expect(side.querySelector<HTMLTextAreaElement>('#commit-message')!.value).toBe('Fix the thing');
  });

  it('stays disabled with the reason on hover while the AI provider is off', async () => {
    S.settings = { ...S.settings, 'general.headless-ai-provider': 'off' };
    await render([], [row('a.ts', 'M', 'staged')]);
    expect(btn().disabled).toBe(true);
    const reason = 'Turn on an AI provider in Settings to write commit messages';
    expect(btn().getAttribute('aria-label')).toBe(reason);
    // a disabled .ico takes no pointer events, so its own title would never show
    expect(btn().parentElement!.getAttribute('title')).toBe(reason);

    S.settings = { ...S.settings, 'general.headless-ai-provider': 'claude' }; notify(); await tick();
    expect(btn().disabled).toBe(false);
    expect(btn().getAttribute('aria-label')).toBe('Write the commit message with Claude');
  });
});
