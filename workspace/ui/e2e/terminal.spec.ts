import { expect, test } from './fixtures';

test('a new terminal runs a command and shows its output', async ({ page, open }) => {
  const mock = await open();
  await page.keyboard.press('ControlOrMeta+T');
  await mock.idle();
  await expect(page.locator('.term-host')).toBeVisible();
  await page.keyboard.type('echo hi from the test');
  await page.keyboard.press('Enter');
  await mock.idle();
  // the typed command is echoed first, so only a line of its own tells the output apart
  expect(await mock.terminalText()).toContain('\r\nhi from the test\r\n');
  await expect(page.locator('.term-host .xterm-rows > div').filter({ hasText: /^hi from the test\s*$/ }))
    .toHaveCount(1);
});

test('closing a terminal removes it from the rail', async ({ page, open }) => {
  const mock = await open();
  const sessions = page.locator('.rail .rail-b:not(.new)');
  await page.keyboard.press('ControlOrMeta+T');
  await mock.idle();
  // the review scenario starts with a shell and an agent session
  await expect(sessions).toHaveCount(3);
  await page.keyboard.press('ControlOrMeta+Shift+P');
  await page.keyboard.type('Terminal: Close Session');
  await page.keyboard.press('Enter');
  await mock.idle();
  await expect(sessions).toHaveCount(2);
});

test('an existing agent session is replayed into the rail', async ({ page, open }) => {
  const mock = await open();
  await page.keyboard.press('ControlOrMeta+Shift+T');
  await mock.idle();
  expect(await mock.terminalText(2)).toContain('Welcome to Claude Code');
  await expect(page.locator('.term-host')).toBeVisible();
});

test('a shell wears the icon of its first long command, an ended session the power sign, rail and dialog alike',
  async ({ page, open }) => {
    const mock = await open('terminals');
    const tile = (cap: string) => page.locator('.rail .rail-b').filter({ hasText: cap }).locator('.tile');
    // browser mode's stand-in AI names an icon by a word of the command, so `pnpm dev` gets one
    await expect(tile('zsh:2').locator('.pick svg')).toBeVisible();
    await expect(tile('zsh:2').locator('.num')).toHaveCount(0);
    await expect(tile('zsh:1').locator('.num')).toHaveText('1');
    // the scenario's bash ended with exit 1
    await expect(tile('bash:1').locator('.ended svg')).toBeVisible();
    expect((await mock.calls()).filter((c) => c === 'ai_command_icons')).toHaveLength(1);

    await page.keyboard.press('ControlOrMeta+Shift+P');
    await page.keyboard.type('Terminals and Orphans');
    await page.keyboard.press('Enter');
    await mock.idle();
    const row = (id: number) => page.locator('.orphans-table tbody tr')
      .filter({ has: page.locator('.sess', { hasText: new RegExp(`(^|\\D)${id}$`) }) });
    await expect(row(4).locator('.sess-glyph .pick svg')).toBeVisible();
    await expect(row(5).locator('.sess-glyph .agent.claude')).toBeVisible();
    await expect(row(3).locator('.sess-glyph .ended svg')).toBeVisible();
  });
