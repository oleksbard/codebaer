import { expect, test } from './fixtures';

test('the open repo is starred in its preferences, and a closed one waits to be reopened', async ({ page, open }) => {
  const mock = await open();
  const trigger = page.locator('.repo-trigger');
  // browser mode's stand-in AI gives the shop a cart
  await expect(trigger.locator('.repo-avatar svg')).toBeVisible();
  await trigger.click();
  await expect(page.locator('.repo-item .name')).toHaveText(['tiny-router', 'website']);
  await page.getByRole('menuitem', { name: 'Repository Preferences…' }).click();
  const prefs = page.getByRole('dialog', { name: 'Acme Shop preferences' });
  const favorite = prefs.getByRole('checkbox', { name: 'Favorite' });
  await expect(favorite).not.toBeChecked();
  await favorite.click();
  await mock.idle();
  await expect(favorite).toBeChecked();
  await prefs.getByRole('button', { name: 'Done' }).click();
  await expect(prefs).toBeHidden();

  await trigger.click();
  await page.getByRole('menuitem', { name: 'Close Repository' }).click();
  await mock.idle();
  await expect(trigger).toHaveText(/No repository/);
  await expect(page.locator('.row')).toHaveCount(0);
  expect(await mock.calls()).toContain('close_repo');
  await expect(page.getByRole('heading', { name: 'No repository open' })).toBeVisible();
  const card = page.locator('.no-repo-card');
  await expect(card).toContainText('Acme Shop~/projects/acme-shop');
  await expect(card.locator('.repo-avatar svg:not(.repo-fav)')).toBeVisible();
  await expect(card.locator('.repo-fav')).toBeVisible();

  await trigger.click();
  await expect(page.locator('.repo-item .name')).toHaveText(['Acme Shop', 'tiny-router', 'website']);
  await expect(page.locator('.repo-item', { hasText: 'Acme Shop' }).locator('.repo-fav')).toBeVisible();
  await expect(page.locator('.repo-item', { hasText: 'website' }).locator('.repo-fav')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await card.click();
  await mock.idle();
  await expect(trigger).toHaveText(/Acme Shop/);
  await expect(page.locator('.row').first()).toBeVisible();
});

test('a push still running keeps the repo from closing, and the close works after it', async ({ page, open }) => {
  const mock = await open('review', { slow: '600' });
  const close = async () => {
    await page.locator('.repo-trigger').click();
    await page.getByRole('menuitem', { name: 'Close Repository' }).click();
  };
  await page.getByRole('button', { name: 'Push 1 commit' }).click();
  await close();
  await expect(page.locator('.toast')).toHaveText(['Wait for the git action to finish']);
  await mock.idle();
  expect(await mock.calls()).not.toContain('close_repo');
  await expect(page.locator('.toast')).toHaveText(['Wait for the git action to finish', 'Pushed']);

  await close();
  await mock.idle();
  await expect(page.getByRole('heading', { name: 'No repository open' })).toBeVisible();
});

test('an icon picked in the preferences replaces the AI\'s, and stays after a reload', async ({ page, open }) => {
  await open();
  const avatar = page.locator('.repo-trigger .repo-avatar');
  await expect(avatar.locator('svg')).toBeVisible();
  const ai = await avatar.innerHTML();
  await page.locator('.repo-trigger').click();
  await page.getByRole('menuitem', { name: 'Repository Preferences…' }).click();
  await page.locator('.icon-pick-b').click();
  await page.getByRole('searchbox', { name: 'Search icons' }).fill('rocket');
  await page.getByRole('button', { name: 'lucide:rocket', exact: true }).click();
  await expect(page.locator('.icon-pick-b')).toHaveText('rocket');
  await page.getByRole('button', { name: 'Done' }).click();
  const picked = await avatar.innerHTML();
  expect(picked).not.toBe(ai);

  await open();
  await expect(avatar.locator('svg')).toBeVisible();
  expect(await avatar.innerHTML()).toBe(picked);
});

test('the switcher draws the icon the AI picked for a repo, and its code for one without', async ({ page, open }) => {
  let mock = await open();
  const avatar = (name: string) => page.locator('.repo-item', { hasText: name }).locator('.repo-avatar');
  const asks = async () => (await mock.calls()).filter((c) => c === 'ai_repo_icons');
  // browser mode's stand-in AI names an icon by a word of the repo name
  await expect(page.locator('.repo-trigger .repo-avatar svg')).toBeVisible();
  await page.locator('.repo-trigger').click();
  await expect(avatar('tiny-router').locator('svg:not(.repo-fav)')).toBeVisible();
  await mock.idle();
  await expect(avatar('website')).toHaveText('WE');
  expect(await asks()).toHaveLength(2);

  mock = await open();
  await expect(page.locator('.repo-trigger .repo-avatar svg')).toBeVisible();
  await page.locator('.repo-trigger').click();
  await expect(avatar('tiny-router').locator('svg:not(.repo-fav)')).toBeVisible();
  // website, which got no icon, is asked about again after a reload
  await expect.poll(asks).toHaveLength(1);
});
