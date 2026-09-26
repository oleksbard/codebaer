import { Channel, invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { afterEach, describe, expect, test, vi } from 'vitest';
import lib from '../../../backend/src/lib.rs?raw';
import { errKind, type Blob, type FileText, type Status } from '#ipc/git';
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
  const saved = { name: 'Type check', command: 'pnpm exec tsc --noEmit', repo: null, hide_terminal: false };
  const run = (task: object) => invoke('task_run', { task, cols: 80, rows: 24 });
  await expect(run({ t: 'Custom', ...saved })).resolves.toBeTypeOf('number');
  await expect(run({ t: 'Custom', ...saved, command: 'rm -rf /' })).rejects.toMatchObject({ kind: 'Io' });
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
  expect(events[0]).toMatchObject({ t: 'Hello', proto: 3 });
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
