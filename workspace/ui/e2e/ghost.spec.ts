import type { Locator, Page } from '@playwright/test';
import { expect, row, test } from './fixtures';

/** package.json with "dev" removed (a chunk that only deletes: no shared prefix with its neighbours, which a
 *  character-level diff could otherwise fold into an adjacent line) and "test" split into two scripts (a chunk
 *  that deletes and adds), an unchanged line apart so the two stay separate chunks. */
const NEW_PACKAGE = `{
  "name": "acme-shop",
  "private": true,
  "packageManager": "pnpm@10.12.0",
  "scripts": {
    "build": "tsc && vite build",
    "lint": "oxlint src",
    "test": "vitest run --pool=threads",
    "test:watch": "vitest"
  }
}
`;

type Rect = { top: number; height: number };
const rectOf = (box: { y: number; height: number }): Rect => ({ top: box.y, height: box.height });

const union = (boxes: { y: number; height: number }[]): Rect => {
  const top = Math.min(...boxes.map((b) => b.y));
  const bottom = Math.max(...boxes.map((b) => b.y + b.height));
  return { top, height: bottom - top };
};

const closeTo = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(1);

/** The ghost's own rect, read from the inline style `place()` sets and never rewrites (the Web Animations API
 *  animates the used value, not the style attribute), so this is stable regardless of how far its exit has
 *  played by the time this reads it. */
async function ghostRect(page: Page, selector: string): Promise<Rect> {
  return page.$eval(selector, (raw) => {
    const el = raw as HTMLElement;
    const parent = el.parentElement!.getBoundingClientRect();
    return { top: parent.top + parseFloat(el.style.top), height: parseFloat(el.style.height) };
  });
}

/** Accepts through `accept`, checks the ghost it leaves against `expected` (captured before the click, since
 *  the accept removes the chunk this measures), and waits for the ghost to be gone. */
async function acceptAndCheckGhost(page: Page, accept: Locator, selector: string, expected: Rect) {
  await accept.click();
  const ghost = page.locator(selector).first();
  await expect(ghost).toBeVisible();
  const box = await ghostRect(page, selector);
  closeTo(box.top, expected.top);
  closeTo(box.height, expected.height);
  await ghost.waitFor({ state: 'detached', timeout: 1000 });
}

test('the hunk ghost covers the deletion widget and the changed lines, in unified mode', async ({ page, open }) => {
  const mock = await open('review', { motion: 'on' });
  await mock.agentEdit('package.json', NEW_PACKAGE);
  await mock.idle();
  await row(page, 'unstaged', 'package.json').click();
  await mock.idle();

  // the chunk that only deletes ("dev") comes first in the document
  const deleteOnly = page.locator('.cm-deletedChunk').first();
  const beforeDeleteOnly = rectOf((await deleteOnly.boundingBox())!);
  await acceptAndCheckGhost(page, deleteOnly.locator('button[name=accept]'), '.cm-ghost.accept', beforeDeleteOnly);

  // with that chunk gone, one deletion widget and two changed lines are left, for the delete-and-add chunk
  await expect(page.locator('.cm-deletedChunk')).toHaveCount(1);
  const widget = page.locator('.cm-deletedChunk').first();
  const lines = page.locator('.cm-changedLine');
  await expect(lines).toHaveCount(2);
  const boxes = [await widget.boundingBox(), await lines.nth(0).boundingBox(), await lines.nth(1).boundingBox()]
    .map((b) => b!);
  await acceptAndCheckGhost(page, widget.locator('button[name=accept]'), '.cm-ghost.accept', union(boxes));
});

test('the hunk ghost covers the changed lines in each pane, side by side', async ({ page, open }) => {
  const mock = await open('review', { motion: 'on' });
  await mock.agentEdit('package.json', NEW_PACKAGE);
  await mock.idle();
  await row(page, 'unstaged', 'package.json').click();
  await mock.idle();
  await page.getByRole('button', { name: 'Side by side' }).click();
  await mock.idle();

  // the delete-only chunk shows only on the left: nothing changed on the right to ghost there
  const deletedLeft = page.locator('.cm-merge-a .cm-changedLine').first();
  const beforeLeft = rectOf((await deletedLeft.boundingBox())!);
  await acceptAndCheckGhost(page, page.locator('.cm-merge-b .cm-deletedChunk').first().locator('button[name=accept]'),
    '.cm-merge-a .cm-ghost.accept', beforeLeft);

  // the delete-and-add chunk left: the two new lines show on the right, one of them wrapped over two visual lines
  const rightLines = page.locator('.cm-merge-b .cm-changedLine');
  await expect(rightLines).toHaveCount(2);
  const rightBoxes = [await rightLines.nth(0).boundingBox(), await rightLines.nth(1).boundingBox()].map((b) => b!);
  const expectedRight = union(rightBoxes);
  await acceptAndCheckGhost(page, page.locator('.cm-merge-b .cm-deletedChunk').first().locator('button[name=accept]'),
    '.cm-merge-b .cm-ghost.accept', expectedRight);
});
