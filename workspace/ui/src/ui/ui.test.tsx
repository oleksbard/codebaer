import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { tick } from '../test-setup';
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
  it('Button variants map to classes and forward native props', () => {
    const h = mount(<><Button>a</Button><Button variant="primary" disabled>b</Button>
      <Button variant="ghost">c</Button></>);
    const bs = [...h.querySelectorAll('button')];
    expect(bs.map((b) => b.className)).toEqual(['btn', 'btn primary', 'btn ghost']);
    expect(bs[1]!.disabled).toBe(true);
  });

  it('IconButton needs a label and shows it as aria-label and title; busy adds the class', () => {
    const h = mount(<IconButton label="Stage" busy>+</IconButton>);
    const b = h.querySelector('button')!;
    expect(b.getAttribute('aria-label')).toBe('Stage');
    expect(b.title).toBe('Stage');
    expect(b.className).toBe('ico busy');
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

  it('FileIcon resolves a per-extension glyph and a theme colour, and falls back for unknown names', () => {
    const h = mount(<><FileIcon name="model.ts" /><FileIcon name="notes.md" /><FileIcon name="whatever.qqq" /></>);
    const icons = [...h.querySelectorAll<HTMLElement>('.ficon')];
    expect(icons.map((i) => i.querySelector('svg') !== null)).toEqual([true, true, true]);
    const paths = icons.map((i) => i.querySelector('path')!.getAttribute('d'));
    expect(new Set(paths).size).toBe(3);
    expect(icons.every((i) => i.style.color.startsWith('var(--'))).toBe(true);
  });
});
