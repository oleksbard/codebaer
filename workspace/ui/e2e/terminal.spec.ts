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

test('the current terminal fills its tile, as the current tab of the activity bar does', async ({ page, open }) => {
  const mock = await open();
  const fill = (sel: string) => page.locator(sel).evaluate((el) => getComputedStyle(el).backgroundColor);
  const tabFill = await fill('.rail-item[data-state="active"] .rail-ind');
  await page.keyboard.press('ControlOrMeta+Shift+T');
  await mock.idle();
  // the current tile and the current tab share one indicator now, not a static background
  expect(await fill('.rail-b.on .rail-ind')).toBe(tabFill);
  expect(await page.locator('.rail-b:not(.on):not(.new) >> nth=0 >> .rail-ind').count()).toBe(0);
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

test('hovering a file path in a terminal shows the lines around it, until a key goes back to the terminal',
  async ({ page, open }) => {
    const mock = await open();
    await page.keyboard.press('ControlOrMeta+T');
    await mock.idle();
    await page.keyboard.type('echo src/cart.ts:12 missing.ts');
    await page.keyboard.press('Enter');
    await mock.idle();
    const row = page.locator('.term-host .xterm-rows > div').filter({ hasText: /^src\/cart\.ts:12 missing\.ts\s*$/ });
    // xterm's screen layer takes the pointer for the rows under it
    const box = (await row.boundingBox())!;
    await page.mouse.move(box.x + 40, box.y + box.height / 2);

    const card = page.locator('.hovercard');
    await expect(card.locator('.term-peek-path')).toHaveText('src/cart.ts:12');
    await expect(card.locator('.term-peek-code > div.on')).toHaveText(/^12\s+return \{$/);
    await expect(card.locator('.term-peek-code > div')).toHaveCount(7);

    await page.keyboard.press('a');
    await expect(card).toHaveCount(0);
  });

test('the pointer can go from the path onto the card, whose button opens the file', async ({ page, open }) => {
  const mock = await open();
  await page.keyboard.press('ControlOrMeta+T');
  await mock.idle();
  await page.keyboard.type('echo src/cart.ts:12');
  await page.keyboard.press('Enter');
  await mock.idle();
  const row = page.locator('.term-host .xterm-rows > div').filter({ hasText: /^src\/cart\.ts:12\s*$/ });
  const box = (await row.boundingBox())!;
  await page.mouse.move(box.x + 40, box.y + box.height / 2);
  const card = page.locator('.hovercard');
  const button = card.getByRole('button', { name: 'Open in Default App' });
  await expect(button).toBeVisible();

  // off the path, across the gap and onto the card, in a few steps as a hand does
  const target = (await button.boundingBox())!;
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 6 });
  await page.mouse.click(target.x + target.width / 2, target.y + target.height / 2);

  await expect(card).toHaveCount(0);
  expect(await page.evaluate(() => globalThis.__mock!.calls.filter((c) => c.cmd === 'open_file').map((c) => c.args)))
    .toEqual([{ path: 'src/cart.ts' }]);
});
