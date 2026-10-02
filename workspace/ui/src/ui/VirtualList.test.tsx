import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tick } from '#test-setup';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { VirtualList } from './VirtualList';

let root: Root;
let box: HTMLDivElement | null = null;
let scrollTop = 0;

beforeEach(() => {
  document.body.innerHTML = '<div id="host"></div>';
  root = createRoot(document.getElementById('host')!);
  scrollTop = 0;
});

afterEach(() => {
  root.unmount();
  document.body.innerHTML = '';
});

/** jsdom lays nothing out, so the box reports a 260px viewport (ten 26px rows) and keeps its own scrollTop. */
function render(count: number, reveal: { row: number; id: string } | null = null): void {
  flushSync(() => root.render(
    <VirtualList label="Rows" count={count} rowHeight={26} reveal={reveal}
      ref={(el) => {
        if (!el || el === box) return;
        box = el;
        Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => 260 });
        Object.defineProperty(el, 'scrollTop', {
          configurable: true, get: () => scrollTop, set: (v: number) => { scrollTop = v; },
        });
      }}
      row={(i, id) => <div key={i} id={id} className="r" data-i={i} />} />,
  ));
}

const drawn = () => [...document.querySelectorAll<HTMLElement>('.r')].map((r) => Number(r.dataset.i));

describe('VirtualList', () => {
  it('draws the rows in view and a few past them, and moves that window on a scroll', async () => {
    render(10_000);
    expect(drawn()[0]).toBe(0);
    expect(drawn().at(-1)).toBe(19);
    const body = document.querySelector<HTMLElement>('.vlist-body')!;
    expect(body.style.height).toBe('260000px');

    scrollTop = 26 * 500;
    box!.dispatchEvent(new Event('scroll'));
    // a scroll is a continuous event, which React renders after the task rather than inside flushSync
    await tick();
    expect(drawn()[0]).toBe(490);
    expect(drawn().at(-1)).toBe(519);
    expect(body.style.paddingTop).toBe(`${490 * 26}px`);
  });

  it('scrolls a revealed row into view once, and not again when only its place changes', () => {
    render(1000, { row: 300, id: 'a' });
    expect(scrollTop).toBe(301 * 26 - 260);

    scrollTop = 0;
    render(1000, { row: 310, id: 'a' });
    expect(scrollTop).toBe(0);

    render(1000, { row: 5, id: 'b' });
    expect(scrollTop).toBe(0);
    render(1000, { row: 600, id: 'c' });
    expect(scrollTop).toBe(601 * 26 - 260);
  });

  it('reveals a row that was not there yet as soon as it is', () => {
    render(1000, { row: -1, id: 'a' });
    expect(scrollTop).toBe(0);
    render(1000, { row: 400, id: 'a' });
    expect(scrollTop).toBe(401 * 26 - 260);
  });

  it('is a tree whose active descendant is the cursor row while that row is drawn', () => {
    render(100, { row: 3, id: 'c' });
    const tree = document.querySelector<HTMLElement>('[role=tree]')!;
    expect(tree.getAttribute('aria-label')).toBe('Rows');
    expect(document.getElementById(tree.getAttribute('aria-activedescendant')!)!.dataset.i).toBe('3');
    render(100, null);
    expect(tree.hasAttribute('aria-activedescendant')).toBe(false);
  });

  it('draws the last rows at once when the list shrinks below where it was scrolled', async () => {
    render(10_000);
    scrollTop = 26 * 9000;
    box!.dispatchEvent(new Event('scroll'));
    await tick();
    expect(drawn()[0]).toBe(8990);
    render(50);
    expect(drawn()).toContain(49);
    const body = document.querySelector<HTMLElement>('.vlist-body')!;
    expect(parseFloat(body.style.paddingTop)).toBeLessThanOrEqual(parseFloat(body.style.height));
  });
});
