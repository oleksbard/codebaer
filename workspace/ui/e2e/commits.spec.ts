import { expect, row, test } from './fixtures';

const SEEDED = 'Show the item count in the cart summary';

test('Commits lists what a push would send, newest first, cut short to fit, and a push empties it', async ({
  page, open,
}) => {
  const mock = await open();
  const commits = page.locator('details[data-sec="commits"]');
  await expect(commits.locator('.commit-row .summary')).toHaveText([SEEDED]);

  const long = 'Move the discount rules out of the cart and into their own module so checkout can share them';
  await page.getByRole('textbox', { name: 'Commit message' }).fill(`${long}\n\nWith a body the row leaves out`);
  await page.locator('#commit-btn').click();
  await mock.idle();
  await expect(commits.locator('.commit-row .summary')).toHaveText([long, SEEDED]);
  await expect(commits.locator('summary .n')).toHaveText('2');
  const cut = await commits.locator('.commit-row .summary').first().evaluate((el) => el.scrollWidth > el.clientWidth);
  expect(cut).toBe(true);
  await expect(page.locator('details[data-sec="staged"]')).toHaveCount(0);

  await page.getByRole('button', { name: 'Push 2 commits' }).click();
  await mock.idle();
  await expect(commits).toHaveCount(0);
  expect((await mock.state()).outgoing).toEqual([]);
});

test('Revert last commit puts its changes back in Staged and its message back in the box', async ({ page, open }) => {
  const mock = await open();
  const box = page.getByRole('textbox', { name: 'Commit message' });
  await box.fill('Tidy the checkout\n\nWhy it needed tidying');
  await page.locator('#commit-btn').click();
  await mock.idle();
  await expect(row(page, 'staged', 'src/checkout.ts')).toHaveCount(0);

  await page.locator('details[data-sec="commits"] summary [data-all="undo"]').click();
  await mock.idle();
  await expect(row(page, 'staged', 'src/checkout.ts')).toBeVisible();
  await expect(box).toHaveValue('Tidy the checkout\n\nWhy it needed tidying');
  await expect(page.locator('details[data-sec="commits"] .commit-row .summary')).toHaveText([SEEDED]);
  await expect(page.locator('.branch .ab')).toContainText('↑1');
  const s = await mock.state();
  expect(s.outgoing).toEqual([SEEDED]);
  expect(s.files['src/checkout.ts']!.head).not.toBe(s.files['src/checkout.ts']!.index);
});
