import { expect, test } from './fixtures';

test('a star moves a repo to the top of the switcher without opening it', async ({ page, open }) => {
  const mock = await open();
  await page.locator('.repo-trigger').click();
  const names = page.locator('.repo-item .name');
  await expect(names).toHaveText(['tiny-router', 'acme-shop', 'website']);
  const website = page.locator('.repo-item', { hasText: 'website' });
  await website.hover();
  const before = (await mock.calls()).length;
  await website.getByRole('button', { name: 'Favorite' }).click();
  await mock.idle();
  await expect(names).toHaveText(['website', 'tiny-router', 'acme-shop']);
  await expect(website.getByRole('button', { name: 'Favorite' })).toHaveAttribute('aria-pressed', 'true');
  expect((await mock.calls()).slice(before)).toEqual(['favorite_repo']);
});

test('Cmd-D unstars the highlighted repo, which stays highlighted where it lands', async ({ page, open }) => {
  const mock = await open();
  await page.locator('.repo-trigger').click();
  const router = page.locator('.repo-item', { hasText: 'tiny-router' });
  await router.hover();
  await page.keyboard.press('ControlOrMeta+D');
  await mock.idle();
  await expect(page.locator('.repo-item .name')).toHaveText(['acme-shop', 'website', 'tiny-router']);
  await expect(router).toBeFocused();
  await expect(router).toHaveAttribute('data-highlighted', '');
});
