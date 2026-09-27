import { expect, test } from './fixtures';

test('the bear menu shows the AI tools to install first and opens their install guide', async ({ page, open }) => {
  const mock = await open('claude-only');
  await page.getByRole('button', { name: 'CodeBär menu' }).click();
  await page.getByRole('menuitem', { name: 'Explore AI Tools…' }).click();
  await mock.idle();

  const dialog = page.getByRole('dialog', { name: 'AI coding tools' });
  await expect(dialog.getByRole('heading', { level: 3 })).toHaveText(['Codex CLI', 'OpenCode', 'Claude Code']);
  const claude = dialog.getByRole('listitem').filter({ hasText: 'Claude Code' });
  await expect(claude.getByText('Installed')).toBeVisible();
  await expect(claude.getByRole('button')).toHaveCount(0);
  await expect(dialog).toBeFocused();

  await dialog.getByRole('button', { name: 'OpenCode install guide' }).click();
  await mock.idle();
  const opened = await page.evaluate(() => globalThis.__mock!.calls.filter((c) => c.cmd === 'open_url'));
  expect(opened.map((c) => c.args)).toEqual([{ url: 'https://opencode.ai/download' }]);
});

test('the native menu item opens it, with every card marked installed when every tool is', async ({ page, open }) => {
  const mock = await open();
  await mock.menu('ai-tools');
  await mock.idle();
  const dialog = page.getByRole('dialog', { name: 'AI coding tools' });
  await expect(dialog.getByText('Installed', { exact: true })).toHaveCount(3);
  await expect(dialog.getByRole('listitem').getByRole('button')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});
