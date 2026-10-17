import { beforeEach, describe, expect, it, vi } from 'vitest';
import { git } from '#ipc/git';
import { DEFAULTS } from '#ipc/settings';
import { telemetry } from '#ipc/telemetry';
import { confirmDialog } from '#kernel/dialogs';
import { notify, S } from '#kernel/store';
import { tick } from '#test-setup';
import { loadSettings } from './settings';
import { startUsageData, USAGE_ASK } from './usage';

vi.mock('#ipc/git', async () => {
  const actual = await vi.importActual<typeof import('#ipc/git')>('#ipc/git');
  return { ...actual, git: Object.fromEntries(Object.keys(actual.git).map((k) => [k, vi.fn()])) };
});
vi.mock('#ipc/telemetry', async () => {
  const actual = await vi.importActual<typeof import('#ipc/telemetry')>('#ipc/telemetry');
  return { ...actual, telemetry: { available: vi.fn(), promptDue: vi.fn(), answered: vi.fn() } };
});

const t = vi.mocked(telemetry);

/** Starts the check and waits for the question, which it asks after two backend answers. In an object, since an
 *  async function that returned the run would wait for it. */
async function asked(): Promise<{ run: Promise<void> }> {
  const run = startUsageData();
  await tick();
  await tick();
  return { run };
}

function answer(yes: boolean): void {
  S.confirm?.resolve(yes);
  S.confirm = null;
  notify();
}

beforeEach(async () => {
  vi.mocked(git.settings).mockResolvedValue({ ...DEFAULTS });
  vi.mocked(git.commands).mockResolvedValue([]);
  vi.mocked(git.hiddenScripts).mockResolvedValue({});
  vi.mocked(git.saveSettings).mockReset().mockResolvedValue(undefined);
  t.available.mockReset().mockResolvedValue(true);
  t.promptDue.mockReset().mockResolvedValue(true);
  t.answered.mockReset().mockResolvedValue(undefined);
  S.confirm = null;
  S.usageDataAvailable = false;
  await loadSettings();
});

describe('the usage data question', () => {
  it('is never asked by a build that cannot send, and the option stays hidden', async () => {
    t.available.mockResolvedValue(false);
    await startUsageData();
    expect(S.usageDataAvailable).toBe(false);
    expect(t.promptDue).not.toHaveBeenCalled();
    expect(S.confirm).toBeNull();
  });

  it('is not asked before the backend says it is due', async () => {
    t.promptDue.mockResolvedValue(false);
    await startUsageData();
    expect(S.usageDataAvailable).toBe(true);
    expect(S.confirm).toBeNull();
    expect(t.answered).not.toHaveBeenCalled();
  });

  it('says what is sent, with its own answers', async () => {
    const { run } = await asked();
    expect(S.confirm?.message).toBe(USAGE_ASK);
    expect(S.confirm?.ok).toBe('Share usage data');
    expect(S.confirm?.cancel).toBe('No thanks');
    answer(false);
    await run;
  });

  it('turns sharing on for a yes', async () => {
    const { run } = await asked();
    answer(true);
    await run;
    expect(S.settings['general.usage-data']).toBe('on');
    expect(git.saveSettings).toHaveBeenCalledWith(expect.objectContaining({ 'general.usage-data': 'on' }));
    expect(t.answered).toHaveBeenCalledWith(true);
  });

  it('leaves sharing off for a no or a close, and says so once', async () => {
    const { run } = await asked();
    answer(false);
    await run;
    expect(S.settings['general.usage-data']).toBe('off');
    expect(git.saveSettings).not.toHaveBeenCalled();
    expect(t.answered).toHaveBeenCalledExactlyOnceWith(false);
  });

  it('asks again next launch when the save of a yes fails', async () => {
    vi.mocked(git.saveSettings).mockRejectedValue(new Error('disk full'));
    const { run } = await asked();
    answer(true);
    await run;
    expect(S.settings['general.usage-data']).toBe('off');
    expect(t.answered).not.toHaveBeenCalled();
  });

  it('takes no answer from a dialog that replaced it', async () => {
    const { run } = await asked();
    const other = confirmDialog('Discard?');
    await run;
    expect(S.confirm?.message).toBe('Discard?');
    expect(t.answered).not.toHaveBeenCalled();
    answer(false);
    expect(await other).toBe(false);
  });

  it('waits for a later launch while something else is on screen', async () => {
    S.confirm = { id: -1, message: 'Discard?', resolve: () => {} };
    await startUsageData();
    expect(S.confirm.message).toBe('Discard?');
    expect(t.answered).not.toHaveBeenCalled();
  });
});
