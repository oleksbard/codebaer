import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

const option = (page: Page, value: 'On' | 'Off') =>
  page.getByRole('radiogroup', { name: 'Share usage data' }).getByRole('radio', { name: value });

test('a yes to the launch question turns sharing on', async ({ page, open }) => {
  const mock = await open('usage-data');
  const ask = page.getByRole('alertdialog', { name: 'Help improve CodeBär?' });
  await expect(ask).toContainText('It never sends code, file names, paths or repository names.');
  await ask.getByRole('button', { name: 'Share usage data' }).click();
  await mock.idle();
  await expect(ask).toHaveCount(0);
  expect(await mock.calls()).toContain('telemetry_answered');

  await mock.menu('settings');
  await expect(option(page, 'On')).toHaveAttribute('aria-checked', 'true');
});

test('a no leaves sharing off', async ({ page, open }) => {
  const mock = await open('usage-data');
  const ask = page.getByRole('alertdialog', { name: 'Help improve CodeBär?' });
  await ask.getByRole('button', { name: 'No thanks' }).click();
  await mock.idle();
  await expect(ask).toHaveCount(0);
  expect(await mock.calls()).toContain('telemetry_answered');
  expect(await mock.calls()).not.toContain('settings_set');

  await mock.menu('settings');
  await expect(option(page, 'Off')).toHaveAttribute('aria-checked', 'true');
});

test('a build that cannot send neither asks nor shows the option', async ({ page, open }) => {
  const mock = await open();
  await mock.menu('settings');
  await expect(page.getByRole('radiogroup', { name: 'Auto fetch' })).toBeVisible();
  await expect(page.getByRole('radiogroup', { name: 'Share usage data' })).toHaveCount(0);
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
});
