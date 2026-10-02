import { Channel, invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { afterEach, describe, expect, test, vi } from 'vitest';
import lib from '../../../backend/src/lib.rs?raw';
import { errKind, type Blob, type FileText, type SearchFile, type SearchMsg, type Status } from '#ipc/git';
import type { Settings } from '#ipc/settings';
import type { ServerMsg } from '#ipc/terminal';
import { createBackend } from './backend';
import { SCENARIOS } from './scenarios';

let current: ReturnType<typeof createBackend> | null = null;

function boot(name = 'review') {
  const backend = createBackend(name, SCENARIOS[name]!(), { slow: 0, latency: 0, theme: null });
  mockIPC((cmd, args) => backend.invoke(cmd, (args ?? {}) as Record<string, unknown>), { shouldMockEvents: true });
  current = backend;
  return backend;
}

// a watcher emit still pending from one test would land in the next one's listeners
afterEach(async () => {
  await current?.api.idle();
  current = null;
  clearMocks();
});

const entry = (s: Status, path: string) => s.files.find((f) => f.path === path);

test('there is a handler for every command lib.rs registers, and none for one it does not', () => {
  const list = /generate_handler!\[([^\]]*)\]/.exec(lib)?.[1] ?? '';
  const registered = list.split(',').map((c) => c.trim().split('::').at(-1)!).filter(Boolean).sort();
  expect(registered.length).toBeGreaterThan(40);
  const handled = boot().commands.filter((c) => !c.startsWith('plugin:')).sort();
  expect(handled).toEqual(registered);
});

describe('status', () => {
  test('reports each kind of change the way status.rs parses porcelain v2', async () => {
    boot();
    const s = await invoke<Status>('status');
    expect(s).toMatchObject({ branch: 'cart-discounts', upstream: 'origin/cart-discounts', ahead: 1, behind: 0 });
    expect(entry(s, 'src/cart.ts')).toMatchObject({ indexStatus: '.', worktreeStatus: 'M', untracked: false });
    expect(entry(s, 'src/checkout.ts')).toMatchObject({ indexStatus: 'M', worktreeStatus: 'M' });
    expect(entry(s, 'src/money.ts')).toMatchObject({ indexStatus: '.', worktreeStatus: 'D' });
    expect(entry(s, 'src/utils/money.ts')).toMatchObject({ indexStatus: '.', worktreeStatus: '.', untracked: true });
    expect(entry(s, 'README.md')).toBeUndefined();
  });

  test('a conflicted path is UU and cannot be read from the index', async () => {
    boot('conflict');
    expect(entry(await invoke<Status>('status'), 'src/cart.ts')).toMatchObject({ conflicted: true });
    await expect(invoke('read_blob', { rev: 'index', path: 'src/cart.ts' })).rejects.toEqual({ kind: 'Conflicted' });
  });
});

test('diff_stat counts the review queue in lines, untracked whole, staged and binary not at all', async () => {
  const b = boot();
  const before = await invoke<{ added: number; removed: number }>('diff_stat');
  b.api.agentEdit('src/new.ts', 'a\nb\nc');
  b.api.agentEdit('static/logo.png', 'PNG v3');
  await b.api.idle();
  expect(await invoke('diff_stat')).toEqual({ added: before.added + 3, removed: before.removed });
  await invoke('stage_path', { path: 'src/new.ts' });
  expect(await invoke('diff_stat')).toEqual(before);
});

describe('writes carry a baseline', () => {
  test('write_file refuses a stale expected text and hands back what is on disk', async () => {
    boot();
    const disk = await invoke<FileText>('read_file', { path: 'src/cart.ts' });
    const stale = invoke('write_file', { path: 'src/cart.ts', text: 'x', eol: 'lf', expected: 'old' });
    await expect(stale).rejects.toEqual({ kind: 'Stale', detail: disk });
    await invoke('write_file', { path: 'src/cart.ts', text: 'x', eol: 'lf', expected: disk.text });
    expect(await invoke<FileText>('read_file', { path: 'src/cart.ts' })).toMatchObject({ text: 'x' });
  });

  test('stage_content refuses a stale index oid, and stages against the current one', async () => {
    const b = boot();
    const idx = await invoke<Blob>('read_blob', { rev: 'index', path: 'src/cart.ts' });
    const args = { path: 'src/cart.ts', text: 'staged', eol: 'lf' };
    await expect(invoke('stage_content', { ...args, expectedOid: 'nope' })).rejects.toEqual({ kind: 'StaleIndex' });
    await invoke('stage_content', { ...args, expectedOid: idx.oid });
    expect(b.api.state().files['src/cart.ts']?.index).toBe('staged');
  });
});

test('commit makes the index HEAD, leaves unstaged edits, and puts the branch one ahead', async () => {
  const b = boot();
  await invoke('stage_path', { path: 'src/cart.ts' });
  await invoke('commit', { message: 'Add discounts' });
  const s = await invoke<Status>('status');
  expect(entry(s, 'src/cart.ts')).toBeUndefined();
  expect(entry(s, 'src/checkout.ts')).toMatchObject({ indexStatus: '.', worktreeStatus: 'M' });
  expect(s.ahead).toBe(2);
  expect(b.api.state().files['src/cart.ts']?.head).toBe(b.api.state().files['src/cart.ts']?.work);
  await expect(invoke('commit', { message: 'again' })).rejects.toMatchObject({ kind: 'Git' });
});

test('push on a branch with no upstream sets one on origin, as push_args does', async () => {
  const b = boot();
  await invoke('create_branch', { name: 'topic' });
  await invoke('push');
  expect(b.api.state()).toMatchObject({ branch: 'topic', upstream: 'origin/topic', ahead: 0 });
});

test('a custom task runs only while it is still saved for this repo', async () => {
  boot();
  const saved = { name: 'Type check', command: 'pnpm exec tsc --noEmit', repo: null, hide_terminal: false, icon: null };
  const run = (task: object) => invoke('task_run', { task, cols: 80, rows: 24 });
  await expect(run({ t: 'Custom', ...saved })).resolves.toBeTypeOf('number');
  await expect(run({ t: 'Custom', ...saved, command: 'rm -rf /' })).rejects.toMatchObject({ kind: 'Io' });
});

test('ai_command_icons answers with ids from the sets it is sent, and refuses while the AI is off', async () => {
  boot();
  const sets = [{ prefix: 'lucide', title: 'Lucide', names: ['hammer'] }];
  const items = [{ name: 'build', command: 'vite build' }, { name: 'dev', command: 'vite' }];
  expect(await invoke('ai_command_icons', { items, sets })).toEqual(['lucide:hammer', null]);
  await invoke('command_icons_set', { picks: { 'build\nvite build': 'lucide:hammer' } });
  expect(await invoke('command_icons_get')).toEqual({ 'build\nvite build': 'lucide:hammer' });
  const now = await invoke<Settings>('settings_get');
  await invoke('settings_set', { settings: { ...now, 'general.headless-ai-provider': 'off' } });
  await expect(invoke('ai_command_icons', { items, sets })).rejects.toMatchObject({ kind: 'Ai' });
});

test('ai_repo_icons answers from the repo names, and refuses while the AI is off', async () => {
  boot();
  const sets = [{ prefix: 'lucide', title: 'Lucide', names: ['shopping-cart', 'route'] }];
  const items = [{ path: '/r/acme-shop', name: 'acme-shop' }, { path: '/r/website', name: 'website' }];
  expect(await invoke('ai_repo_icons', { items, sets })).toEqual(['lucide:shopping-cart', null]);
  const now = await invoke<Settings>('settings_get');
  await invoke('settings_set', { settings: { ...now, 'general.headless-ai-provider': 'off' } });
  await expect(invoke('ai_repo_icons', { items, sets })).rejects.toMatchObject({ kind: 'Ai' });
});

test('close_repo leaves the repo commands failing as NotARepo until the repo opens again', async () => {
  boot();
  await invoke('close_repo');
  await expect(invoke('status')).rejects.toMatchObject({ kind: 'NotARepo' });
  await expect(invoke('stage_all')).rejects.toMatchObject({ kind: 'NotARepo' });
  expect(await invoke('recent_repos')).not.toEqual([]);
  await invoke('open_repo', { path: SCENARIOS.review!().root });
  await expect(invoke('status')).resolves.toMatchObject({ files: expect.any(Array) });
});

test('idle waits for a task to finish', async () => {
  const b = boot();
  await invoke('term_subscribe', { out: new Channel(), ev: new Channel() });
  await invoke('task_run', { task: { t: 'Script', name: 'test' }, cols: 80, rows: 24 });
  await b.api.idle();
  expect(b.api.terminalText()).toContain('Done in');
});

test('a change fires repo-changed, as the watcher does', async () => {
  const b = boot();
  const fired = vi.fn();
  await listen('repo-changed', fired);
  b.api.agentEdit('src/new.ts', 'export {};\n');
  await b.api.idle();
  expect(fired).toHaveBeenCalledOnce();
  expect(entry(await invoke<Status>('status'), 'src/new.ts')).toMatchObject({ untracked: true });
});

test('a command with no handler rejects and logs, and fail() rejects the next call only', async () => {
  const b = boot();
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  await expect(invoke('no_such_command')).rejects.toMatchObject({ kind: 'Io' });
  expect(log).toHaveBeenCalledWith('[mock] no handler for no_such_command');
  log.mockRestore();
  b.api.fail('push', { kind: 'Git', detail: 'rejected' });
  await expect(invoke('push')).rejects.toEqual({ kind: 'Git', detail: 'rejected' });
  await expect(invoke('push')).resolves.toBeNull();
});

test('git_version fails when the scenario has no git', async () => {
  boot('no-git');
  const e: unknown = await invoke('git_version').catch((x: unknown) => x);
  expect(errKind(e)).toBe('Io');
});

test('terminals: subscribe says hello, a spawn is announced after its req, and output is framed by id', async () => {
  boot();
  const events: ServerMsg[] = [];
  const frames: { id: number; text: string }[] = [];
  const out = new Channel<ArrayBuffer | number[]>();
  out.onmessage = (m) => {
    const buf = m as ArrayBuffer;
    frames.push({ id: new DataView(buf).getUint32(0, true), text: new TextDecoder().decode(new Uint8Array(buf, 4)) });
  };
  const ev = new Channel<ServerMsg>();
  ev.onmessage = (m) => events.push(m);
  await invoke('term_subscribe', { out, ev });
  expect(events[0]).toMatchObject({ t: 'Hello', proto: 4 });
  expect(frames.some((f) => f.id === 1 && f.text.includes('pnpm test'))).toBe(true);

  const req = await invoke<number>('term_spawn', { kind: { t: 'Shell', path: '/bin/zsh' }, cols: 80, rows: 24 });
  expect(events.some((m) => m.t === 'Spawned')).toBe(false);
  await new Promise((r) => setTimeout(r, 0));
  const spawned = events.find((m) => m.t === 'Spawned');
  expect(spawned).toMatchObject({ req, info: { title: 'zsh', tier: 'marks' } });
  const id = spawned?.t === 'Spawned' ? spawned.info.id : -1;

  frames.length = 0;
  await invoke('term_input', { id, data: 'echo hi\r' });
  expect(frames.filter((f) => f.id === id).map((f) => f.text).join('')).toContain('hi\r\n');
  expect(events.at(-2)).toEqual({ t: 'Command', id, code: 0 });
});

test('the video scenario has the two changes its story needs and three idle agent sessions', async () => {
  const b = boot('video');
  const s = await invoke<Status>('status');
  expect(s.files.map((f) => f.path)).toEqual(['src/cart.ts', 'src/checkout.ts']);
  expect(s).toMatchObject({ upstream: 'origin/item-discounts', ahead: 0 });
  expect(b.api.terminalText(1)).toContain('Apply per-item discounts to the cart total.');
  const events: ServerMsg[] = [];
  const ev = new Channel<ServerMsg>();
  ev.onmessage = (m) => events.push(m);
  await invoke('term_subscribe', { out: new Channel<ArrayBuffer | number[]>(), ev });
  const hello = events.find((m) => m.t === 'Hello');
  expect(hello?.t === 'Hello' ? hello.sessions.map((x) => [x.title, x.tier, x.state.t]) : []).toEqual([
    ['claude', 'process', 'Idle'], ['codex', 'process', 'Idle'], ['opencode', 'process', 'Idle'],
  ]);
});

describe('a comment pasted into an agent session', () => {
  const paste = (text: string) => invoke('term_input', { id: 1, data: `\x1b[200~${text}\x1b[201~` });
  const typed = (data: string) => invoke('term_input', { id: 1, data });

  test('is echoed once as a block, and the Enter that submits it gets no answer', async () => {
    const b = boot('video');
    const before = b.api.terminalText(1);
    await paste('src/cart.ts:20\rconst net = 1;\r\rClamp this at zero.');
    await typed('\r');
    expect(b.api.terminalText(1).slice(before.length))
      .toBe('src/cart.ts:20\r\n  const net = 1;\r\n\r\n  Clamp this at zero.\r\n\r\n');
  });

  test('does not swallow an Enter that comes after typing, and a second paste is a block of its own', async () => {
    const b = boot('video');
    await paste('one\rtwo');
    await paste('three');
    await typed('x');
    const before = b.api.terminalText(1);
    await typed('\r');
    expect(b.api.terminalText(1).slice(before.length)).toContain('Browser mode has no agent. It heard: x');
    expect(b.api.terminalText(1)).toContain('one\r\n  two\r\n\r\nthree\r\n\r\n');
  });

  test('still gets an answer per line in a shell, where a paste is just typing', async () => {
    const b = boot();
    await invoke('term_input', { id: 1, data: '\x1b[200~echo hi\x1b[201~\r' });
    expect(b.api.terminalText(1)).toContain('echo hi\r\nhi\r\n');
  });

  test('is typing, not a block, in a task session', async () => {
    const b = boot('video');
    await invoke('task_run', { task: { t: 'Script', name: 'test' }, cols: 80, rows: 24 });
    await invoke('term_input', { id: 4, data: '\x1b[200~echo\x1b[201~' });
    expect(b.api.terminalText(4).endsWith('echo')).toBe(true);
  });

  test('is ignored by an exited session', async () => {
    const b = boot('video');
    await invoke('term_kill', { id: 1 });
    const before = b.api.terminalText(1);
    await paste('one');
    expect(b.api.terminalText(1)).toBe(before);
  });

  test('is not needed for an Enter to draw a new prompt: with no paste before it, it only draws one', async () => {
    const b = boot('video');
    const before = b.api.terminalText(1);
    await typed('\r');
    expect(b.api.terminalText(1).slice(before.length)).toBe('\r\n\x1b[35m>\x1b[0m ');
  });
});

test('terminalWrite prints into the given session, into the newest one for no id, and not into an exited one',
  async () => {
    const b = boot('video');
    b.api.terminalWrite('one\n', 1);
    b.api.terminalWrite('two\n');
    await invoke('term_kill', { id: 2 });
    b.api.terminalWrite('three\n', 2);
    expect(b.api.terminalText(1)).toContain('one\r\n');
    expect(b.api.terminalText(3)).toContain('two\r\n');
    expect(b.api.terminalText(2)).not.toContain('three');
  });

test('a claude session answers its approval with a key and stops on Esc, as typed() in agent.rs does', async () => {
  const b = boot('review');
  const events: ServerMsg[] = [];
  const ev = new Channel<ServerMsg>();
  ev.onmessage = (m) => events.push(m);
  await invoke('term_subscribe', { out: new Channel(), ev });
  const agent = () => events.filter((m) => m.t === 'Agent').at(-1);
  b.api.terminalAgent({ phase: 'approval', turn_ms: Date.now() }, 2);
  await invoke('term_input', { id: 2, data: '\x1b[B' });
  expect(agent()).toMatchObject({ id: 2, agent: { phase: 'approval' } });
  await invoke('term_input', { id: 2, data: '\r' });
  expect(agent()).toMatchObject({ agent: { phase: 'working', ask: null } });
  await invoke('term_input', { id: 2, data: '\x1b' });
  expect(agent()).toMatchObject({ agent: { phase: 'idle', end: 'interrupted' } });

  for (const keys of [['3'], ['\x1b[B', '\x1b[B', '\r']]) {
    b.api.terminalAgent({ phase: 'approval', end: null }, 2);
    for (const data of keys) await invoke('term_input', { id: 2, data });
    expect(agent(), keys.join(' ')).toMatchObject({ agent: { phase: 'idle', end: 'interrupted' } });
  }
  const rev = agent()?.t === 'Agent' ? agent()!.agent.rev : -1;
  b.api.terminalAgent({ phase: 'approval' }, 2);
  await invoke('term_input', { id: 2, data: 'x' });
  expect(agent()).toMatchObject({ agent: { phase: 'approval', rev: rev + 1 } });

  b.api.terminalAgent({ phase: 'compacting', end: 'done', took_ms: 5000 }, 2);
  await invoke('term_input', { id: 2, data: '\x1b' });
  expect(agent(), 'a /compact between turns').toMatchObject({ agent: { phase: 'idle', end: 'done', took_ms: 5000 } });
});

describe('search, as search.rs answers it', () => {
  let run = 0;
  /** The paths found, after the Done that ends the search. */
  async function find(query: string, include = ''): Promise<{ paths: string[]; truncated: boolean }> {
    const files: SearchFile[] = [];
    let truncated: boolean | null = null;
    const out = new Channel<SearchMsg>();
    out.onmessage = (m) => { if (m.t === 'Files') files.push(...m.files); else truncated = m.truncated; };
    await invoke('search', { query, include, run: ++run, out });
    await vi.waitFor(() => expect(truncated).not.toBeNull());
    return { paths: files.map((f) => f.path), truncated: truncated! };
  }

  test('a name with no slash is a folder at any depth, one with a slash starts at the root, and * stays in a folder',
    async () => {
      boot('big');
      const pkg = 'apps/apps-3/src/hooks/hooks-5';
      expect((await find('hooks5x7', pkg)).paths).toEqual([`${pkg}/file-7.ts`]);
      expect((await find('hooks5x7', `./${pkg}/`)).paths).toEqual([`${pkg}/file-7.ts`]);
      expect((await find('hooks5x7', 'hooks-5')).paths).toHaveLength(50);
      expect((await find('hooks5x7', 'apps/*.ts')).paths).toEqual([]);
      expect((await find('hooks5x7', 'apps/**/file-7.ts, packages/packages-0')).paths).toHaveLength(26);
    });

  test('a leading slash or ./ starts at the root, braces, classes and escapes are globs, a bad one is InvalidPath',
    async () => {
      boot('big');
      expect((await find('hooks5x7', '/hooks-5')).paths).toEqual([]);
      expect((await find('hooks5x7', './hooks-5')).paths).toEqual([]);
      expect((await find('hooks5x7', '/apps/apps-3')).paths).toHaveLength(1);
      expect((await find('hooks5x7', 'apps/apps-{3,4}/src, x')).paths).toHaveLength(2);
      expect((await find('hooks5x7', 'apps/apps-[34]')).paths).toHaveLength(2);
      await expect(find('x', 'src/{a')).rejects.toMatchObject({ kind: 'InvalidPath' });
      await expect(find('x', 'src/[a')).rejects.toMatchObject({ kind: 'InvalidPath' });
      await expect(find('x', 'src}')).rejects.toMatchObject({ kind: 'InvalidPath' });
      expect((await find('hooks5x7', 'apps/\\*')).paths).toEqual([]);
    });

  test('answers nothing to a run older than one it has started', async () => {
    boot();
    await find('lineitem');
    const sent: SearchMsg[] = [];
    const out = new Channel<SearchMsg>();
    out.onmessage = (m) => sent.push(m);
    await invoke('search', { query: 'lineitem', include: '', run: run - 1, out });
    expect(sent).toEqual([]);
  });

  test('ignores case unless the query has a capital, and stops at the cap', async () => {
    boot();
    expect((await find('linetotal')).paths).toEqual([]);
    expect((await find('lineitem')).paths).toEqual((await find('LineItem')).paths);
    expect((await find('LINEITEM')).paths).toEqual([]);
    boot('big');
    expect(await find('shared')).toMatchObject({ truncated: true });
  });
});
