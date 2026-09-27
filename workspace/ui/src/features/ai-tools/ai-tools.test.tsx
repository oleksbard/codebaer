import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { tick } from '#test-setup';
import { AI_PROVIDERS, type AiProvider } from '#ipc/settings';

vi.mock('#ipc/git', async () => {
  const actual = await vi.importActual<typeof import('#ipc/git')>('#ipc/git');
  return { ...actual, git: { ...actual.git, installedAiProviders: vi.fn(), openUrl: vi.fn() } };
});
vi.mock('#kernel/dialogs', async () => ({
  ...(await vi.importActual<object>('#kernel/dialogs')), toast: vi.fn(),
}));
vi.mock('#features/command-icons', () => ({ SetIcon: () => null }));

const { git } = await import('#ipc/git');
const { toast } = await import('#kernel/dialogs');
const { S } = await import('#kernel/store');
const { closeAiTools, openAiTools } = await import('./actions');
const { AiToolsOverlay } = await import('./AiToolsDialog');
const { TOOLS } = await import('./catalog');

const installed = vi.mocked(git.installedAiProviders);
const writeText = vi.fn<(text: string) => Promise<void>>();
let root: Root;

/** A check that answers only when the test says so. */
function pending() {
  let answer!: (list: AiProvider[]) => void;
  let fail!: (e: unknown) => void;
  installed.mockReturnValueOnce(new Promise((res, rej) => { answer = res; fail = rej; }));
  return { answer: async (list: AiProvider[]) => { answer(list); await tick(); }, fail };
}

const names = () => [...document.querySelectorAll('.ai-tool h3')].map((h) => h.textContent);
const installedNames = () => [...document.querySelectorAll('.ai-tool.installed h3')].map((h) => h.textContent);
const card = (tool: string) => [...document.querySelectorAll<HTMLElement>('.ai-tool')]
  .find((c) => c.querySelector('h3')?.textContent === tool)!;
const guide = (tool: string) => card(tool).querySelector<HTMLButtonElement>('.ai-tool-get')!;
const copyButton = (tool: string) => card(tool).querySelector<HTMLButtonElement>('.ai-tool-copy')!;

beforeEach(() => {
  vi.clearAllMocks();
  installed.mockReset();
  S.aiTools = null;
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  document.body.innerHTML = '<div id="host"></div>';
  root = createRoot(document.getElementById('host')!);
  flushSync(() => root.render(<AiToolsOverlay />));
});

afterEach(() => {
  closeAiTools();
  root.unmount();
  document.body.innerHTML = '';
});

it('has a card for every provider the backend can find', () => {
  expect(TOOLS.map((t) => t.id)).toEqual([...AI_PROVIDERS]);
  for (const t of TOOLS) expect(t.url).toMatch(/^https:\/\//);
});

it('puts the tools to install first, and the installed ones last with nothing to install', async () => {
  installed.mockResolvedValue(['claude']);
  openAiTools();
  await tick();
  expect(names()).toEqual(['Codex CLI', 'OpenCode', 'Claude Code']);
  expect(installedNames()).toEqual(['Claude Code']);
  expect(card('Claude Code').querySelector('.ai-tool-installed')?.textContent).toBe('Installed');
  expect(card('Claude Code').querySelector('.ai-tool-command, .ai-tool-actions')).toBeNull();
  expect(card('Codex CLI').querySelector('.ai-tool-installed')).toBeNull();
  expect(guide('Codex CLI')).toBeTruthy();
});

it('waits for the check before it lists anything, with the focus on the dialog rather than Close', async () => {
  const check = pending();
  openAiTools();
  await tick();
  expect(document.activeElement?.classList.contains('ai-tools')).toBe(true);
  expect(names()).toEqual([]);
  expect(document.querySelectorAll('.ai-tool.placeholder')).toHaveLength(3);
  expect(document.querySelector('[role="status"]')?.textContent).toMatch(/Checking/);
  await check.answer([]);
  expect(names()).toEqual(['Claude Code', 'Codex CLI', 'OpenCode']);
  expect(installedNames()).toEqual([]);
});

it('marks every card installed when every tool is, and offers nothing to install', async () => {
  installed.mockResolvedValue(['claude', 'codex', 'opencode']);
  openAiTools();
  await tick();
  expect(installedNames()).toEqual(['Claude Code', 'Codex CLI', 'OpenCode']);
  expect(document.querySelector('.ai-tool-command, .ai-tool-actions')).toBeNull();
});

it('marks none installed when the first check fails; a later failure keeps the last answer and says so', async () => {
  installed.mockRejectedValueOnce({ kind: 'Ai', detail: 'no shell' });
  openAiTools();
  await tick();
  expect(names()).toHaveLength(3);
  expect(installedNames()).toEqual([]);
  expect(document.querySelector('.ai-tools-note')).not.toBeNull();

  // the failure stays on screen while it tries again, and the button keeps the focus
  const retry = pending();
  const again = document.querySelector<HTMLButtonElement>('.ai-tools-note button')!;
  again.focus();
  again.click();
  await tick();
  expect(document.querySelectorAll('.ai-tool.placeholder')).toHaveLength(0);
  expect(document.activeElement).toBe(document.querySelector('.ai-tools-note button'));
  again.click();
  expect(installed).toHaveBeenCalledTimes(2);
  await retry.answer(['codex']);
  expect(names()).toEqual(['Claude Code', 'OpenCode', 'Codex CLI']);
  expect(installedNames()).toEqual(['Codex CLI']);

  expect(document.querySelector('.ai-tools-note')).toBeNull();

  installed.mockRejectedValueOnce({ kind: 'Ai', detail: 'no shell' });
  globalThis.dispatchEvent(new Event('focus'));
  await tick();
  expect(installedNames()).toEqual(['Codex CLI']);
  expect(document.querySelector('.ai-tools-note')).not.toBeNull();
});

it('checks again when the window gets the focus back, once at a time', async () => {
  installed.mockResolvedValue(['claude']);
  openAiTools();
  await tick();
  const check = pending();
  globalThis.dispatchEvent(new Event('focus'));
  globalThis.dispatchEvent(new Event('focus'));
  expect(installed).toHaveBeenCalledTimes(2);
  await check.answer(['claude', 'codex']);
  expect(names()).toEqual(['OpenCode', 'Claude Code', 'Codex CLI']);
});

it('drops a check that answers after the dialog was closed and opened again', async () => {
  const late = pending();
  openAiTools();
  closeAiTools();
  const fresh = pending();
  openAiTools();
  await late.answer([]);
  expect(S.aiTools).toEqual({ installed: null, checking: true, failed: false });
  await fresh.answer(['opencode']);
  expect(installedNames()).toEqual(['OpenCode']);
});

it('opens the install guide, and says so when it cannot', async () => {
  installed.mockResolvedValue([]);
  openAiTools();
  await tick();
  guide('OpenCode').click();
  expect(git.openUrl).toHaveBeenCalledWith('https://opencode.ai/download');

  vi.mocked(git.openUrl).mockRejectedValueOnce({ kind: 'Io', detail: 'no browser' });
  guide('Codex CLI').click();
  await tick();
  expect(toast).toHaveBeenCalledWith(expect.stringMatching(/github\.com\/openai\/codex: no browser/), 'err');
});

it('copies the install command and shows that it did', async () => {
  installed.mockResolvedValue([]);
  openAiTools();
  await tick();
  writeText.mockResolvedValueOnce();
  copyButton('Claude Code').click();
  await tick();
  expect(writeText).toHaveBeenCalledWith('curl -fsSL https://claude.ai/install.sh | bash');
  // the line breaks it may take after a slash are markup only, so the text shown is the text copied
  expect(card('Claude Code').querySelector('code')!.textContent).toBe('curl -fsSL https://claude.ai/install.sh | bash');
  expect(card('Claude Code').querySelectorAll('code wbr')).toHaveLength(1);
  expect(copyButton('Claude Code').textContent).toBe('Copied');
  expect(card('Claude Code').querySelector('[role="status"]')?.textContent)
    .toBe('Copied the Claude Code install command');

  writeText.mockRejectedValueOnce(new Error('denied'));
  copyButton('Codex CLI').click();
  await tick();
  expect(toast).toHaveBeenCalledWith('Could not copy the command: Error: denied', 'err');
  expect(copyButton('Codex CLI').textContent).toBe('Copy');
});
