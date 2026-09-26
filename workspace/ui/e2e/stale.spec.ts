import { expect, test } from './fixtures';

test('an agent edit under a dirty buffer is flagged, not overwritten', async ({ page, open }) => {
  const mock = await open();
  // the file changes before the first keystroke and the watcher reports it only after the last, so
  // neither the autosave nor the refresh can win a race: each finds a dirty buffer on a changed file
  await mock.agentEdit('src/cart.ts', 'export const agent = true;\n', { watcher: false });
  await page.locator('.cm-content').first().click();
  await page.keyboard.press('End');
  await page.keyboard.type(' // mine');
  await mock.emit('repo-changed');
  await mock.idle();
  await expect(page.getByText('changed on disk')).toBeVisible();
  expect((await mock.state()).files['src/cart.ts']!.work).toBe('export const agent = true;\n');
});

test('an index that moved under an accept drops the accept and says so', async ({ page, open }) => {
  const mock = await open();
  await mock.fail('stage_content', { kind: 'StaleIndex' });
  await page.keyboard.press('Meta+Y');
  await mock.idle();
  await expect(page.getByText('index changed under you')).toBeVisible();
  await expect(page.getByText('hunk 1 of 3')).toBeVisible();
  const cart = (await mock.state()).files['src/cart.ts']!;
  expect(cart.index).toBe(cart.head);
});
