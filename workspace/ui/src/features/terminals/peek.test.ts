import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Terminal, type ILink } from '@xterm/xterm';
import { S } from '#kernel/store';

const files = new Map<string, string>();
/** Stats of these paths wait until the test resolves them. */
const slow = new Map<string, () => void>();

vi.mock('#ipc/git', async () => {
  const actual = await vi.importActual<typeof import('#ipc/git')>('#ipc/git');
  return {
    ...actual,
    git: {
      imageStamp: vi.fn(async (_rev: null, path: string) => {
        if (slow.has(path)) await new Promise<void>((r) => slow.set(path, r));
        return files.has(path) ? `stamp:${path}` : null;
      }),
      readFile: vi.fn((path: string) => Promise.resolve(
        files.has(path) ? { text: files.get(path)!, eol: 'lf', exists: true } : { text: '', eol: 'lf', exists: false },
      )),
      readImage: vi.fn(() => Promise.resolve(new Uint8Array([137, 80, 78, 71]).buffer)),
      openFile: vi.fn(() => Promise.resolve()),
      peekStamp: vi.fn((path: string) => Promise.resolve(files.has(path) ? `stamp:${path}` : null)),
      peekText: vi.fn((path: string) => Promise.resolve(
        files.has(path) ? { text: files.get(path)!, eol: 'lf', exists: true } : { text: '', eol: 'lf', exists: false },
      )),
    },
  };
});

const { git } = await import('#ipc/git');
const { candidates, enterPeek, hidePeek, leavePeek, peekLinks } = await import('./peek');

describe('a path printed in a terminal resolves to a file of the repository', () => {
  it('tries the terminal folder, then the root, and keeps only paths inside the repository', () => {
    expect(candidates('src/a.ts', '/r/pkg', '/r')).toEqual(['pkg/src/a.ts', 'src/a.ts']);
    expect(candidates('./a.ts', '/r', '/r')).toEqual(['a.ts']);
    expect(candidates('../b.ts', '/r/pkg', '/r')).toEqual(['b.ts']);
    expect(candidates('/r/src/a.ts', '/elsewhere', '/r')).toEqual(['src/a.ts']);
    expect(candidates('../../x.ts', '/r', '/r')).toEqual([]);
    expect(candidates('/r', '/r', '/r')).toEqual([]);
  });

  it('keeps a file outside the repository as an absolute path', () => {
    expect(candidates('/tmp/notes.md', '/r', '/r')).toEqual(['/tmp/notes.md']);
    // a sibling folder that only shares the root's name as a prefix
    expect(candidates('/r2/a.ts', '/r', '/r')).toEqual(['/r2/a.ts']);
    // a shell in another project prints that project's paths, which the root's same-named file is not
    expect(candidates('src/a.ts', '/other', '/r')).toEqual(['/other/src/a.ts']);
    expect(candidates('src/a.ts', '/other', null)).toEqual(['/other/src/a.ts']);
    expect(candidates('src/a.ts', null, null)).toEqual([]);
  });
});

function write(term: Terminal, text: string): Promise<void> {
  return new Promise((resolve) => term.write(text, resolve));
}

function linksOn(term: Terminal, row: number): Promise<ILink[]> {
  return new Promise((resolve) => {
    peekLinks(term, 1).provideLinks(row, (links) => resolve(links ?? []));
  });
}

const leave = (link: ILink): void => link.leave?.(new MouseEvent('mouseleave'), link.text);
const hover = (link: ILink): void => link.hover?.(new MouseEvent('mousemove', { clientX: 10, clientY: 10 }), link.text);

async function shown(): Promise<NonNullable<typeof S.termPeek>> {
  await vi.waitFor(() => expect(S.termPeek).not.toBeNull());
  return S.termPeek!;
}

describe('the hover card over a file path in a terminal', () => {
  let term: Terminal;

  beforeEach(() => {
    vi.mocked(git.openFile).mockClear();
    files.clear();
    S.root = '/r';
    S.terminals = [{ id: 1, title: 'zsh', cwd: '/r', tier: 'marks', state: { t: 'Idle' } }];
    term = new Terminal({ cols: 60, rows: 6, allowProposedApi: true });
  });

  afterEach(() => {
    hidePeek();
    term.dispose();
  });

  it('links the paths that name a file, with the line and column they carry, and no other word', async () => {
    files.set('src/Alerts.svelte', 'a');
    await write(term, 'see src/Alerts.svelte:10:4, e.g. missing.ts and https://x.io/a.ts');

    const links = await linksOn(term, 1);

    expect(links.map((l) => l.text)).toEqual(['src/Alerts.svelte:10:4']);
    expect(links[0]!.range).toEqual({ start: { x: 5, y: 1 }, end: { x: 26, y: 1 } });
  });

  it('reads the formats compilers print, and not a name that goes on past the extension', async () => {
    for (const f of ['src/a.ts', 'x.ts', 'a.ts', '.eslintrc.json']) files.set(f, 'a');
    await write(term, 'src/a.ts(10,4) x.ts/y a.ts-foo .eslintrc.json');

    const links = await linksOn(term, 1);

    expect(links.map((l) => l.text)).toEqual(['src/a.ts(10,4)', '.eslintrc.json']);
    hover(links[0]!);
    expect((await shown()).line).toBe(10);
  });

  it('drops a reply that comes back after xterm asked about another row', async () => {
    files.set('slow.ts', 'a');
    files.set('fast.ts', 'b');
    slow.set('slow.ts', () => {});
    await write(term, 'slow.ts\r\nfast.ts');
    const provider = peekLinks(term, 1);
    const replies: string[][] = [];
    const reply = (links: ILink[] | undefined): void => { replies.push((links ?? []).map((l) => l.text)); };

    provider.provideLinks(1, reply);
    provider.provideLinks(2, reply);
    await vi.waitFor(() => expect(replies).toEqual([['fast.ts']]));
    slow.get('slow.ts')!();
    slow.clear();
    await new Promise((r) => setTimeout(r, 20));

    expect(replies).toEqual([['fast.ts']]);
  });

  it('links a path that wraps onto the next row on both of its rows', async () => {
    files.set('workspaces/v2/src/lib/components/layout/Alerts.svelte', 'a');
    await write(term, `${'x'.repeat(40)} workspaces/v2/src/lib/components/layout/Alerts.svelte:10`);

    const [first] = await linksOn(term, 1);
    const [second] = await linksOn(term, 2);

    expect(first?.range).toEqual({ start: { x: 42, y: 1 }, end: { x: 37, y: 2 } });
    expect(second?.range).toEqual(first?.range);
  });

  it('shows the lines around the one the path names, and hides when the pointer leaves', async () => {
    files.set('a.ts', Array.from({ length: 20 }, (_, i) => `const v${i + 1} = ${i + 1};`).join('\n'));
    await write(term, 'a.ts:10');
    const [link] = await linksOn(term, 1);

    hover(link!);
    const peek = await shown();

    expect(peek.path).toBe('a.ts');
    expect(peek.body).toMatchObject({ kind: 'code', first: 7, line: 10 });
    const lines = peek.body.kind === 'code' ? peek.body.lines.map((l) => l.map((t) => t.text).join('')) : [];
    expect(lines).toEqual(['const v7 = 7;', 'const v8 = 8;', 'const v9 = 9;', 'const v10 = 10;', 'const v11 = 11;',
      'const v12 = 12;', 'const v13 = 13;']);

    leave(link!);
    await vi.waitFor(() => expect(S.termPeek).toBeNull());
  });

  it('keeps the card through a redraw, which leaves the link and enters it again', async () => {
    files.set('a.ts', 'one');
    await write(term, 'a.ts');
    const [link] = await linksOn(term, 1);
    hover(link!);
    const { id } = await shown();

    for (let i = 0; i < 5; i++) {
      leave(link!);
      await new Promise((r) => setTimeout(r, 40));
      hover(link!);
    }
    await new Promise((r) => setTimeout(r, 200));

    expect(S.termPeek?.id).toBe(id);
  });

  it('still opens the card while a redraw keeps leaving and entering the link before it loaded', async () => {
    files.set('a.ts', 'one');
    await write(term, 'a.ts');
    const [link] = await linksOn(term, 1);

    hover(link!);
    leave(link!);
    await new Promise((r) => setTimeout(r, 20));
    expect(S.termPeek).toBeNull();
    hover(link!);

    expect((await shown()).path).toBe('a.ts');
  });

  it('keeps a pending card from showing after the pointer moved on', async () => {
    files.set('a.ts', 'one');
    await write(term, 'a.ts');
    const [link] = await linksOn(term, 1);

    hover(link!);
    leave(link!);
    await new Promise((r) => setTimeout(r, 20));
    expect(S.termPeek).toBeNull();
    await new Promise((r) => setTimeout(r, 200));

    expect(S.termPeek).toBeNull();
  });

  it('renders a markdown file without its scripts and images', async () => {
    files.set('README.md', '# Title\n\nSome *text*.\n\n<script>alert(1)</script>\n\n![logo](logo.png)\n\n'
      + '<svg pointer-events="all"><a href="https://x.io/"><rect /></a>'
      + '<image href="data:image/png;base64,AA" /></svg>\n\n'
      + '<select><option>a</option></select> <textarea>t</textarea> [site](https://x.io/) <p id="files">p</p>\n');
    await write(term, 'README.md');
    const [link] = await linksOn(term, 1);

    hover(link!);
    const { body } = await shown();

    expect(body.kind).toBe('markdown');
    const html = body.kind === 'markdown' ? body.html : '';
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<em>text</em>');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    for (const banned of ['<svg', '<image', '<select', '<textarea', 'href=', 'id=']) {
      expect(html).not.toContain(banned);
    }
    expect(html).toContain('<a>site</a>');
  });

  it('shows the source of a markdown file when the path names a line', async () => {
    files.set('README.md', '# Title\n\ntext\n');
    await write(term, 'README.md:1');
    const [link] = await linksOn(term, 1);

    hover(link!);
    const { body } = await shown();

    expect(body).toMatchObject({ kind: 'code', first: 1, line: 1 });
  });

  it('shows a file outside the repository, as an agent scratch folder is', async () => {
    files.set('/private/tmp/scratch/plan.md', '# Plan\n');
    await write(term, '- /private/tmp/scratch/plan.md');
    const [link] = await linksOn(term, 1);

    hover(link!);
    const peek = await shown();

    expect(peek.path).toBe('/private/tmp/scratch/plan.md');
    expect(peek.body).toEqual({ kind: 'markdown', html: '<h1>Plan</h1>\n' });
  });

  it('shows an image as a picture', async () => {
    files.set('logo.png', '');
    await write(term, 'logo.png');
    const [link] = await linksOn(term, 1);

    hover(link!);
    const { body } = await shown();

    expect(body.kind).toBe('image');
    expect(body.kind === 'image' && body.url.startsWith('data:image/png;base64,')).toBe(true);
  });

  it('stays open while the pointer is on it, through a redraw under it, and closes once it leaves', async () => {
    files.set('a.ts', 'one');
    await write(term, 'a.ts');
    const [link] = await linksOn(term, 1);
    hover(link!);
    const { id } = await shown();

    leave(link!);
    enterPeek();
    // a redraw, which leaves the link again while the pointer is no longer on it
    leave(link!);
    await new Promise((r) => setTimeout(r, 200));
    expect(S.termPeek?.id).toBe(id);

    leavePeek(id);
    await vi.waitFor(() => expect(S.termPeek).toBeNull());
  });

  it('keeps the card while the pointer crosses the path of the next row on its way down to it', async () => {
    files.set('a.ts', 'one');
    files.set('b.ts', 'two');
    await write(term, 'a.ts\r\nb.ts');
    const [a] = await linksOn(term, 1);
    const [b] = await linksOn(term, 2);
    hover(a!);
    const { id } = await shown();

    leave(a!);
    hover(b!);
    enterPeek();
    leave(b!);
    await new Promise((r) => setTimeout(r, 200));

    expect(S.termPeek?.id).toBe(id);
  });

  it('moves the card to the path of the next row once the pointer stays there', async () => {
    files.set('a.ts', 'one');
    files.set('b.ts', 'two');
    await write(term, 'a.ts\r\nb.ts');
    const [a] = await linksOn(term, 1);
    const [b] = await linksOn(term, 2);
    hover(a!);
    await shown();

    leave(a!);
    hover(b!);

    await vi.waitFor(() => expect(S.termPeek?.path).toBe('b.ts'));
  });

  it('ignores a leave from a card that is no longer under the pointer', async () => {
    files.set('a.ts', 'one');
    await write(term, 'a.ts');
    const [link] = await linksOn(term, 1);
    hover(link!);
    const { id } = await shown();

    leavePeek(id);
    enterPeek();
    leavePeek(id - 1);
    await new Promise((r) => setTimeout(r, 200));

    expect(S.termPeek?.id).toBe(id);
  });

  it('opens the file on Cmd-click, and starts a selection on a plain click', async () => {
    files.set('a.ts', 'one');
    await write(term, 'a.ts');
    const [link] = await linksOn(term, 1);

    link!.activate(new MouseEvent('click'), link!.text);
    expect(git.openFile).not.toHaveBeenCalled();
    link!.activate(new MouseEvent('click', { metaKey: true }), link!.text);
    expect(git.openFile).toHaveBeenCalledWith('a.ts');
  });

  it('takes a click on the card for its own button, and closes on one outside it', async () => {
    files.set('a.ts', 'one');
    await write(term, 'a.ts');
    const [link] = await linksOn(term, 1);
    hover(link!);
    await shown();
    const card = document.createElement('div');
    card.className = 'hovercard';
    const button = card.appendChild(document.createElement('button'));
    document.body.append(card);

    button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(S.termPeek).not.toBeNull();
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(S.termPeek).toBeNull();
    card.remove();
  });

  it('closes on a key, which is the user going back to the terminal', async () => {
    files.set('a.ts', 'one');
    await write(term, 'a.ts');
    const [link] = await linksOn(term, 1);
    hover(link!);
    await shown();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Meta', metaKey: true }));
    expect(S.termPeek).not.toBeNull();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));

    expect(S.termPeek).toBeNull();
  });
});
