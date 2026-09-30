import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

const motionOf = (page: Page) => page.evaluate(() => document.documentElement.dataset.motion);

test('linux with motion on gives lite', async ({ page, open }) => {
  await open('review', { platform: 'linux', motion: 'on' });
  expect(await motionOf(page)).toBe('lite');
});

test('the default platform with motion on gives full', async ({ page, open }) => {
  await open('review', { motion: 'on' });
  expect(await motionOf(page)).toBe('full');
});

test('the fixture default gives off', async ({ page, open }) => {
  await open();
  expect(await motionOf(page)).toBe('off');
});

test('a dropdown menu unmounts after its exit animation, under motion on', async ({ page, open }) => {
  await open('review', { motion: 'on' });
  await page.locator('.brand').click();
  const menu = page.locator('.menu').first();
  await expect(menu).toBeVisible();
  await page.keyboard.press('Escape');
  await menu.waitFor({ state: 'detached' });
});

test('a context menu unmounts after its exit animation, under motion on', async ({ page, open }) => {
  const mock = await open('review', { motion: 'on' });
  await page.getByRole('tab', { name: 'Files' }).click();
  await mock.idle();
  await page.locator('.row.f', { hasText: 'README.md' }).click({ button: 'right' });
  const menu = page.locator('.menu').first();
  await expect(menu).toBeVisible();
  await page.keyboard.press('Escape');
  await menu.waitFor({ state: 'detached' });
});

test('a tooltip unmounts after its exit animation, under motion on', async ({ page, open }) => {
  const mock = await open('review', { motion: 'on' });
  await page.locator('.brand').click();
  await page.getByRole('menuitem', { name: /Settings/ }).click();
  await mock.idle();
  await page.getByRole('button', { name: /What uses the headless/ }).click();
  const tip = page.locator('.tip');
  await expect(tip).toBeVisible();
  await page.keyboard.press('Escape');
  await tip.waitFor({ state: 'detached' });
});

test('a menu command that focuses a terminal keeps that focus past the menu\'s own exit animation', async ({
  page, open,
}) => {
  const mock = await open('review', { motion: 'on' });
  await page.locator('.rail-b.new').click();
  await page.getByRole('menuitem', { name: 'zsh' }).click();
  await mock.idle();
  await page.waitForTimeout(500);
  const focusedInTerminal = await page.evaluate(() => document.activeElement?.closest('.term-host') !== null);
  expect(focusedInTerminal).toBe(true);
});

test('a folder just opened animates its children in, but not again on a later render', async ({ page, open }) => {
  const mock = await open('review', { motion: 'on' });
  await page.getByRole('tab', { name: 'Files' }).click();
  await mock.idle();
  // the first change auto-opens and reveals src/, so src/api is the one still collapsed
  await page.locator('details[data-dir="src/api"] > summary').click();
  await mock.idle();
  await expect(page.locator('details[data-dir="src/api"] .entering').first()).toBeVisible();

  await page.getByRole('tab', { name: /^Changes/ }).click();
  await mock.idle();
  await page.getByRole('tab', { name: 'Files' }).click();
  await mock.idle();
  await expect(page.locator('details[data-dir="src/api"] .entering')).toHaveCount(0);
});
