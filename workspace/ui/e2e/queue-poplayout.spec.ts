import { expect, FULL_MOTION, row, test } from './fixtures';

type PopFrame = { exitingPresent: boolean; exitingAbsolute: boolean; afterMoved: boolean };

/** Samples, on every animation frame from before the action, whether the exiting element (`exitingSel`) is
 *  still present and taken out of flow (`position: absolute`, which `popLayout` gives it), and whether the
 *  element below it (`afterSel`) has already moved up from `afterY0`. Reading these once, after a fixed
 *  sleep, can land before the move has started (a slow run) or long after the exiting element is gone. */
async function recordPop(
  page: import('@playwright/test').Page, exitingSel: string, afterSel: string, afterY0: number,
): Promise<() => Promise<PopFrame[]>> {
  await page.evaluate(([exitingSelector, afterSelector, y0]) => {
    const frames: PopFrame[] = [];
    (window as unknown as { __pop: PopFrame[] }).__pop = frames;
    const t0 = performance.now();
    const tick = () => {
      const exiting = document.querySelector(exitingSelector);
      const after = document.querySelector(afterSelector);
      frames.push({
        exitingPresent: exiting !== null,
        exitingAbsolute: exiting !== null && getComputedStyle(exiting).position === 'absolute',
        afterMoved: after !== null && after.getBoundingClientRect().y < y0 - 3,
      });
      if (performance.now() - t0 < 1000) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, [exitingSel, afterSel, afterY0] as const);
  return () => page.evaluate(() => (window as unknown as { __pop: PopFrame[] }).__pop);
}

test('popLayout takes the exiting queue row out of flow, so the row below starts sliding up right away, not '
  + 'after the whole fade', async ({ page, open }) => {
  const mock = await open('review', FULL_MOTION);
  const cart = row(page, 'unstaged', 'src/cart.ts');
  const checkout = row(page, 'unstaged', 'src/checkout.ts');
  const beforeY = await checkout.evaluate((el) => el.getBoundingClientRect().y);
  const read = await recordPop(
    page, '.row[data-key="unstaged:src/cart.ts"]', '.row[data-key="unstaged:src/checkout.ts"]', beforeY,
  );
  await page.keyboard.press('ControlOrMeta+Shift+Y'); // stages the open file, src/cart.ts
  await mock.idle();
  await cart.waitFor({ state: 'detached', timeout: 2000 });
  const frames = await read();
  // still fading, but out of flow: a broken ref path leaves it position: static until it is removed
  expect(frames.some((f) => f.exitingPresent && f.exitingAbsolute)).toBe(true);
  // checkout.ts, right below cart.ts, starts sliding up into its slot well before cart.ts's own ~140ms
  // fade (let alone its whole remove-and-reflow) would otherwise have let it move
  expect(frames.some((f) => f.exitingAbsolute && f.afterMoved)).toBe(true);
});

test('popLayout takes a closing rail tile out of flow, so the rest start closing up right away', async (
  { page, open },
) => {
  const mock = await open('terminals', FULL_MOTION);
  const tiles = page.locator('.rail-b:not(.new)');
  const bash = page.locator('.rail-b', { hasText: 'bash' });
  // the tile right below bash in the rail's own order, whichever index that is in this scenario
  const order = await tiles.evaluateAll((els) => els.map((el) => el.textContent));
  const after = tiles.nth(order.findIndex((t) => t.includes('bash')) + 1);
  // the name only, not the whole (ticking) label with its relative time: a label that changes text between
  // frames would stop matching an exact selector captured once, before the animation even starts
  const afterSelector = await after.evaluate((el) =>
    `.rail-b[aria-label^="${(el.getAttribute('aria-label') ?? '').split(' · ')[0]}"]`);
  const beforeY = await after.evaluate((el) => el.getBoundingClientRect().y);
  const read = await recordPop(page, '.rail-b[aria-label^="bash"]', afterSelector, beforeY);
  await bash.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Close' }).click();
  await mock.idle();
  await bash.waitFor({ state: 'detached', timeout: 2000 });
  const frames = await read();
  // still fading, but out of flow: a broken ref path leaves it position: static until it is removed
  expect(frames.some((f) => f.exitingPresent && f.exitingAbsolute)).toBe(true);
  // closing the one above it has already started moving this tile up while bash is still out of flow; a
  // broken ref path leaves every tile in flow until bash is fully removed, so none of them move before then
  expect(frames.some((f) => f.exitingAbsolute && f.afterMoved)).toBe(true);
});
