import { expect, row, test } from './fixtures';

test('Stash changes keeps the staged ones, and Unstash brings the stash back by its description', async ({
  page, open,
}) => {
  const mock = await open();
  const before = await mock.state();
  const changes = page.locator('details[data-sec="unstaged"] summary');

  await changes.locator('[data-all="menu"]').click();
  await page.locator('.queue-menu [data-all="stash"]').click();
  await mock.idle();
  await expect(page.getByText('Nothing left to review')).toBeVisible();
  await expect(row(page, 'staged', 'src/checkout.ts')).toBeVisible();
  const stashed = await mock.state();
  expect(stashed.stash).toHaveLength(1);
  expect(stashed.stash[0]!.message).toMatch(/^Changes .+ Written by browser mode/);
  expect(stashed.stash[0]!.branch).toBe(before.branch);
  for (const f of Object.values(stashed.files)) expect(f.work).toBe(f.index);

  // with nothing to review, Unstash is the one action left, so it is a button of its own
  await expect(changes.locator('[data-all]')).toHaveCount(1);
  await changes.locator('[data-all="unstash"]').click();
  await expect(page.locator('.pal li').first()).toContainText(stashed.stash[0]!.message);
  await expect(page.locator('.pal li .sub').first()).toHaveText(`${before.branch} · just now`);
  await page.keyboard.press('Enter');
  await mock.idle();
  expect(await mock.state()).toEqual(before);
  await expect(changes.locator('[data-all="unstash"]')).toHaveCount(0);
});

test('Stash staged changes leaves the unstaged ones in the queue', async ({ page, open }) => {
  const mock = await open();
  await page.locator('details[data-sec="staged"] [data-all="menu"]').click();
  await page.locator('.queue-menu [data-all="stash-staged"]').click();
  await mock.idle();
  await expect(page.locator('details[data-sec="staged"]')).toHaveCount(0);
  await expect(row(page, 'unstaged', 'src/cart.ts')).toBeVisible();
  expect((await mock.state()).stash.map((s) => s.paths)).toEqual([['src/checkout.ts']]);
});

test('a long branch name fits its prompt, and a stash made on it keeps its description readable', async ({
  page, open,
}) => {
  const mock = await open();
  const branch = 'pla-3892-fe-fm-dataroom-access-column-show-the-user-behind-the-deal';
  await page.keyboard.press('ControlOrMeta+Shift+P');
  await page.keyboard.type('Git: Create Branch');
  await page.keyboard.press('Enter');
  expect((await page.locator('.prompt').boundingBox())!.width).toBeGreaterThan(700);
  await page.keyboard.type(branch);
  await page.keyboard.press('Enter');
  await mock.idle();

  const changes = page.locator('details[data-sec="unstaged"] summary');
  await changes.locator('[data-all="menu"]').click();
  await page.locator('.queue-menu [data-all="stash"]').click();
  await mock.idle();
  await changes.locator('[data-all="unstash"]').click();
  const item = page.locator('.pal li').first();
  await expect(item.locator('.sub')).toHaveText(`${branch} · just now`);
  // the description takes the row, with the branch under it rather than beside it
  expect((await item.locator('.lbl').boundingBox())!.width).toBeGreaterThan((await item.boundingBox())!.width * 0.9);
});
