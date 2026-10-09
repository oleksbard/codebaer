import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { tick, tipOf } from '#test-setup';
import { Button } from './Button';
import { IconButton } from './IconButton';
import { Kbd } from './Kbd';
import { Pill } from './Pill';
import { Badge } from './Badge';
import { Spinner } from './Spinner';
import { Tabs } from './Tabs';
import { Dialog } from './Dialog';
import { AlertDialog } from './AlertDialog';
import { ContextMenu } from './ContextMenu';
import { FileIcon } from './FileIcon';
import { DiffStat, diffBlocks } from './DiffStat';
import { InfoTip } from './InfoTip';
import { Tip } from './Tip';

const roots: Root[] = [];
function mount(el: ReactElement): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  flushSync(() => root.render(el));
  return host;
}

afterEach(() => {
  for (const r of roots.splice(0)) r.unmount();
  document.body.innerHTML = '';
});

describe('primitives', () => {
  it('diffBlocks splits five squares by share, lights one per line under five, keeps both sides', () => {
    expect(diffBlocks(0, 0)).toEqual(['none', 'none', 'none', 'none', 'none']);
    expect(diffBlocks(2, 1)).toEqual(['add', 'add', 'del', 'none', 'none']);
    expect(diffBlocks(30, 10)).toEqual(['add', 'add', 'add', 'add', 'del']);
    expect(diffBlocks(1000, 1)).toEqual(['add', 'add', 'add', 'add', 'del']);
    expect(diffBlocks(0, 7)).toEqual(['del', 'del', 'del', 'del', 'del']);
  });

  it('DiffStat names the target counts for assistive tech and draws the squares', () => {
    const h = mount(<DiffStat added={1234} removed={5} />);
    const stat = h.querySelector('.diffstat')!;
    expect(stat.getAttribute('role')).toBe('img');
    expect(stat.getAttribute('aria-label')).toBe('1,234 lines added, 5 removed');
    expect([...stat.querySelectorAll('.blk')].map((b) => b.className)).toEqual(
      ['blk add', 'blk add', 'blk add', 'blk add', 'blk del']);
  });

  it('DiffStat leads with the file count and drops the line half when no line changed', () => {
    const both = mount(<DiffStat added={3} removed={0} files={{ n: 1, label: '1 file to review' }} />)
      .querySelector('.diffstat')!;
    expect(both.getAttribute('aria-label')).toBe('1 file to review, 3 lines added, 0 removed');
    expect(both.querySelector('.files .unit')!.textContent).toBe('file');
    expect(both.querySelector('.sep')).not.toBeNull();
    const only = mount(<DiffStat added={0} removed={0} files={{ n: 2, label: '2 files to review' }} />)
      .querySelector('.diffstat')!;
    expect(only.getAttribute('aria-label')).toBe('2 files to review');
    expect(only.querySelector('.sep, .blk, .n.add')).toBeNull();
  });

  it('Button variants map to classes and forward native props', () => {
    const h = mount(<><Button>a</Button><Button variant="primary" disabled>b</Button>
      <Button variant="ghost">c</Button></>);
    const bs = [...h.querySelectorAll('button')];
    expect(bs.map((b) => b.className)).toEqual(['btn', 'btn primary', 'btn ghost']);
    expect(bs[1]!.disabled).toBe(true);
  });

  it('IconButton names itself with aria-label and shows its label and shortcut in a tip; busy adds the class',
    async () => {
      const h = mount(<IconButton label="Stage" kbd="⌘Y" busy>+</IconButton>);
      const b = h.querySelector('button')!;
      expect(b.getAttribute('aria-label')).toBe('Stage');
      expect(b.hasAttribute('title')).toBe(false);
      expect(b.className).toBe('ico busy');
      expect(await tipOf(b)).toBe('Stage⌘Y');
      expect(document.querySelector('.tip-s kbd')?.textContent).toBe('⌘Y');
    });

  it('Tip leaves the data-state of the trigger it wraps alone', async () => {
    const h = mount(<Tabs value="a" onValueChange={() => {}} vertical
      items={[{ value: 'a', label: 'A', icon: <i /> }, { value: 'b', label: 'B', icon: <i /> }]} />);
    const tabs = [...h.querySelectorAll<HTMLElement>('[role="tab"]')];
    expect(tabs.map((t) => t.dataset['state'])).toEqual(['active', 'inactive']);
    expect(await tipOf(tabs[0]!)).toBe('A');
    expect(tabs[0]!.dataset['state']).toBe('active');
  });

  it('Tip opens on a visible focus only, and the Tip\'s and the trigger\'s focus handlers run either way', async () => {
    let visible = false;
    const matches = Element.prototype.matches;
    const spy = vi.spyOn(Element.prototype, 'matches').mockImplementation(function (this: Element, sel: string) {
      return sel === ':focus-visible' ? visible : matches.call(this, sel);
    });
    const own = vi.fn();
    const child = vi.fn();
    const h = mount(<Tip label="Hi" onFocus={own}><button type="button" onFocus={child}>t</button></Tip>);
    const b = h.querySelector('button')!;
    b.focus();
    await tick();
    expect(document.querySelector('.tip')).toBeNull();
    expect([own.mock.calls.length, child.mock.calls.length]).toEqual([1, 1]);
    b.blur();
    visible = true;
    b.focus();
    await tick();
    expect(document.querySelector('.tip')?.textContent).toBe('Hi');
    expect([own.mock.calls.length, child.mock.calls.length]).toEqual([2, 2]);
    spy.mockRestore();
  });

  it('Tip renders its child alone with no label, and keeps line breaks and a detail line', async () => {
    const h = mount(<><Tip label=""><button type="button" id="a">a</button></Tip>
      <Tip label={'Line one\nline two'} detail="more" slow><button type="button" id="b">b</button></Tip></>);
    expect(await tipOf(h.querySelector('#a')!)).toBeNull();
    const b = h.querySelector<HTMLButtonElement>('#b')!;
    expect(await tipOf(b)).toBe('Line one\nline twomore');
    expect(document.querySelector('.tip-detail')?.textContent).toBe('more');
  });

  it('Kbd, Pill, Badge, Spinner render their classes', () => {
    const h = mount(<><Kbd>⌘Y</Kbd><Pill>a</Pill><Pill tone="warn">b</Pill><Badge>c</Badge><Spinner /></>);
    expect(h.querySelector('kbd')!.textContent).toBe('⌘Y');
    expect([...h.querySelectorAll('.pill')].map((p) => p.className)).toEqual(['pill', 'pill warn']);
    expect(h.querySelector('.badge')!.textContent).toBe('c');
    expect(h.querySelector('.spinner')).not.toBeNull();
  });

  it('Tabs marks the active trigger and reports a change on mousedown', () => {
    const onChange = vi.fn();
    const items = [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }];
    const h = mount(<Tabs value="a" onValueChange={onChange} items={items} />);
    const tabs = [...h.querySelectorAll<HTMLElement>('.tab')];
    expect(tabs.map((t) => t.textContent)).toEqual(['A', 'B']);
    expect(tabs[0]!.dataset.state).toBe('active');
    expect(tabs[1]!.dataset.state).toBe('inactive');
    expect(tabs[0]!.hasAttribute('aria-controls')).toBe(false);
    tabs[1]!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    expect(onChange).toHaveBeenCalledWith('b');
  });

  it('Dialog portals a scrim and a titled box; Escape asks to close', async () => {
    const onOpenChange = vi.fn();
    mount(<Dialog open onOpenChange={onOpenChange} title="Pick" className="pal"><p>body</p></Dialog>);
    await tick();
    expect(document.querySelector('.scrim')).not.toBeNull();
    const box = document.querySelector<HTMLElement>('.dialog.pal')!;
    expect(box.querySelector('.sr-only')!.textContent).toBe('Pick');
    expect(box.querySelector('p')!.textContent).toBe('body');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('Dialog closes from its X button, which does not take the open focus', async () => {
    const onOpenChange = vi.fn();
    mount(<Dialog open onOpenChange={onOpenChange} title="Pick"><input /></Dialog>);
    await tick();
    expect(document.activeElement).toBe(document.querySelector('.dialog input'));
    const x = document.querySelector<HTMLButtonElement>('.dialog-x')!;
    expect(x.getAttribute('aria-label')).toBe('Close');
    expect(x.querySelector('svg')).not.toBeNull();
    x.click();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('AlertDialog shows title, body, Cancel and the confirm label; buttons report the result', async () => {
    const onResult = vi.fn();
    mount(<AlertDialog title="Delete x?" body="Gone for good." confirmLabel="OK" onResult={onResult} />);
    await tick();
    expect(document.querySelector('.dialog-title')!.textContent).toBe('Delete x?');
    expect(document.querySelector('.dialog-body')!.textContent).toBe('Gone for good.');
    const btns = [...document.querySelectorAll<HTMLButtonElement>('.dialog-actions button')];
    expect(btns.map((b) => b.textContent)).toEqual(['Cancel', 'OK']);
    btns[1]!.click();
    expect(onResult).toHaveBeenCalledWith(true);
    expect(onResult).toHaveBeenCalledTimes(1);
  });

  it('AlertDialog reports one false when Cancel is clicked', async () => {
    const onResult = vi.fn();
    mount(<AlertDialog title="Delete x?" onResult={onResult} />);
    await tick();
    document.querySelectorAll<HTMLButtonElement>('.dialog-actions button')[0]!.click();
    expect(onResult).toHaveBeenCalledWith(false);
    expect(onResult).toHaveBeenCalledTimes(1);
  });

  it('AlertDialog reports one false from its X button and still opens focused on Cancel', async () => {
    const onResult = vi.fn();
    mount(<AlertDialog title="Delete x?" onResult={onResult} />);
    await tick();
    expect(document.activeElement?.textContent).toBe('Cancel');
    document.querySelector<HTMLButtonElement>('.dialog-x')!.click();
    expect(onResult).toHaveBeenCalledWith(false);
    expect(onResult).toHaveBeenCalledTimes(1);
  });

  it('AlertDialog reports one false on Escape', async () => {
    const onResult = vi.fn();
    mount(<AlertDialog title="Delete x?" onResult={onResult} />);
    await tick();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(onResult).toHaveBeenCalledWith(false);
    expect(onResult).toHaveBeenCalledTimes(1);
  });

  it('ContextMenu opens on right-click and runs the picked item', async () => {
    const onSelect = vi.fn();
    const h = mount(<ContextMenu items={[{ label: 'One', onSelect }, { label: 'Two', onSelect: () => {} }]}>
      <div className="t">x</div>
    </ContextMenu>);
    h.querySelector('.t')!.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
    await tick();
    const items = [...document.querySelectorAll<HTMLElement>('.menu-item')];
    expect(items.map((i) => i.textContent)).toEqual(['One', 'Two']);
    items[0]!.click();
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('InfoTip opens on focus, stays open when its (i) is pressed, and opens again from a click', async () => {
    const h = mount(<InfoTip label="What uses it"><ul><li>Commit messages</li></ul></InfoTip>);
    const info = h.querySelector<HTMLButtonElement>('.info-tip')!;
    const tip = () => document.querySelector('.tip');
    expect(info.getAttribute('aria-label')).toBe('What uses it');
    info.focus();
    await tick();
    expect(tip()?.textContent).toBe('Commit messages');
    info.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
    await tick();
    expect(tip()).not.toBeNull();
    info.click();
    await tick();
    expect(tip()).not.toBeNull();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await tick();
    expect(tip()).toBeNull();
    info.click();
    await tick();
    expect(tip()).not.toBeNull();
  });

  it('FileIcon resolves a per-extension glyph and a theme colour, and falls back for unknown names', () => {
    const h = mount(<><FileIcon name="model.ts" /><FileIcon name="notes.md" /><FileIcon name="whatever.qqq" /></>);
    const icons = [...h.querySelectorAll<HTMLElement>('.ficon')];
    expect(icons.map((i) => i.querySelector('svg') !== null)).toEqual([true, true, true]);
    const paths = icons.map((i) => i.querySelector('path')!.getAttribute('d'));
    expect(new Set(paths).size).toBe(3);
    expect(icons.every((i) => i.style.color.startsWith('var(--'))).toBe(true);
  });
});
