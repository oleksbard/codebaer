import { expect, fadedOut, FULL_MOTION, recordFade, row, test } from './fixtures';

test('a file moves from Changes to Staged: it lands in Staged, and Changes keeps no duplicate', async (
  { page, open },
) => {
  const mock = await open('review', FULL_MOTION);
  const read = await recordFade(page, '.row[data-key="unstaged:src/cart.ts"]');
  await page.keyboard.press('ControlOrMeta+Shift+Y'); // stages the open file, src/cart.ts
  await mock.idle();
  await row(page, 'unstaged', 'src/cart.ts').waitFor({ state: 'detached', timeout: 2000 });
  // a broken (instant) implementation would have removed the row right away, never sampled with a sub-1
  // opacity; a bound on the elapsed time here would pass even for that, since waiting for detachment alone
  // takes some time regardless of whether anything actually animated
  expect(fadedOut(await read())).toBe(true);
  await expect(row(page, 'staged', 'src/cart.ts')).toBeVisible();
  await expect(row(page, 'unstaged', 'src/cart.ts')).toHaveCount(0);
});

test('a partly staged file keeps a row in both sections, even across a reflow', async ({ page, open }) => {
  const mock = await open('review', FULL_MOTION);
  await expect(row(page, 'unstaged', 'src/checkout.ts')).toBeVisible();
  await expect(row(page, 'staged', 'src/checkout.ts')).toBeVisible();
  // stages a different file, which reflows the whole queue while checkout.ts stays split across both
  // sections; two mounted rows sharing one layoutId break Motion's shared layout and land on top of
  // each other (verified against a build with that bug: both rows measured the same rect)
  await row(page, 'unstaged', 'src/cart.ts').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Stage file' }).click();
  await mock.idle();
  // still mid-reflow: a shared layoutId collides the two rows onto the same rect right about here,
  // before Motion's next-frame correction quietly separates them again
  const unstagedBox = await row(page, 'unstaged', 'src/checkout.ts').boundingBox();
  const stagedBox = await row(page, 'staged', 'src/checkout.ts').boundingBox();
  expect(unstagedBox?.y).not.toBeCloseTo(stagedBox?.y ?? -1, 0);
  await row(page, 'unstaged', 'src/cart.ts').waitFor({ state: 'detached', timeout: 2000 });
  await expect(row(page, 'unstaged', 'src/checkout.ts')).toBeVisible();
  await expect(row(page, 'staged', 'src/checkout.ts')).toBeVisible();
});

test('a commit: the staged rows leave, and the new commit row fades in above the existing one', async (
  { page, open },
) => {
  const mock = await open('review', FULL_MOTION);
  await expect(page.locator('.commit-row')).toHaveCount(1);
  await page.locator('#commit-message').fill('Apply the discount');
  // sampled from before the click: reading the opacity once, right after `mock.idle()`, can just as well
  // land on a frame where the fade has already finished, on a slow run or under worker contention
  const read = await recordFade(page, '.commit-row:first-of-type');
  await page.locator('#commit-btn').click();
  await mock.idle();
  await expect(page.locator('.commit-row')).toHaveCount(2);
  // newest first: the new row is the first one, and a broken (unanimated) implementation would never have
  // been sampled with a sub-1 opacity while present
  expect(fadedOut(await read())).toBe(true);
  await expect(row(page, 'staged', 'src/checkout.ts')).toHaveCount(0);
});

test('closing a terminal from the rail removes its tile and the rest close up', async ({ page, open }) => {
  const mock = await open('terminals', FULL_MOTION);
  const tiles = page.locator('.rail-b:not(.new)');
  const before = await tiles.count();
  const bash = page.locator('.rail-b', { hasText: 'bash' });
  await expect(bash).toBeVisible();
  const read = await recordFade(page, '.rail-b[aria-label^="bash"]');
  await bash.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Close' }).click();
  await mock.idle();
  await bash.waitFor({ state: 'detached', timeout: 2000 });
  // a broken (instant) implementation would have removed it right away, never sampled with a sub-1 opacity;
  // a bound on the elapsed time here would pass even for that, since waiting for detachment takes some time
  // regardless of whether the tile actually animated
  expect(fadedOut(await read())).toBe(true);
  await expect(tiles).toHaveCount(before - 1);
});
