import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorView } from '@codemirror/view';
import { listen } from '#ipc/events';
import { defineFeature, editorExtensions, idle, listenAll, openPalette, register, run } from './registry';
import { S } from './store';

vi.mock('#ipc/events', () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

afterEach(() => {
  register([]);
  S.palette = null;
  S.confirm = null;
});

describe('the registry', () => {
  it('runs a command by id, and nothing while an overlay is open', () => {
    const ran: string[] = [];
    let open = false;
    register([defineFeature({
      id: 'a',
      commands: [{ id: 'a.go', run: () => ran.push('go') }],
      overlays: [{ id: 'a.box', isOpen: () => open, component: () => null }],
    })]);
    run('a.go');
    open = true;
    run('a.go');
    expect(ran).toEqual(['go']);
    expect(idle()).toBe(false);
    expect(idle('a.box')).toBe(true);
  });

  it('refuses a command id registered twice', () => {
    const f = defineFeature({ id: 'a', commands: [{ id: 'x', run() {} }] });
    expect(() => register([f, { ...f, id: 'b' }])).toThrow('command x is registered twice');
  });

  it('lists labelled commands in feature order, with computed entries right after their command', async () => {
    register([
      defineFeature({ id: 'a', commands: [
        { id: 'a.one', label: 'One', run() {} },
        { id: 'a.off', label: 'Off', when: () => false, run() {} },
        { id: 'a.bare', run() {} },
      ] }),
      defineFeature({ id: 'b', commands: [
        { id: 'b.new', label: 'New', more: () => [{ label: 'New zsh', run() {} }], run() {} },
        { id: 'b.find', label: 'Find', run() {} },
      ] }),
    ]);
    const open = openPalette();
    expect(S.palette?.items.map((i) => i.label)).toEqual(['One', 'New', 'New zsh', 'Find']);
    S.palette?.resolve(null);
    await open;
  });

  it('collects editor extensions in feature order', () => {
    const one = EditorView.editable.of(true);
    const two = EditorView.editable.of(false);
    register([
      defineFeature({ id: 'a', editorExtensions: [one] }),
      defineFeature({ id: 'b', editorExtensions: [two] }),
    ]);
    expect(editorExtensions()).toEqual([one, two]);
  });

  it('holds an idle-only event while an overlay is open', async () => {
    const got: unknown[] = [];
    register([defineFeature({ id: 'a', events: { later: { run: (p) => got.push(p), idleOnly: true } } })]);
    await listenAll();
    const handler = vi.mocked(listen).mock.calls[0]![1];
    S.confirm = { message: 'm', resolve() {} };
    handler('first');
    S.confirm = null;
    handler('second');
    expect(got).toEqual(['second']);
  });
});
