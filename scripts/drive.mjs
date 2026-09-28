// Drives the installed Linux app through tauri-driver, with real git, a real terminal and real WebKitGTK, which
// browser mode fakes. CI only, for the reasons smoke.sh gives. Needs tauri-driver and WebKitWebDriver on the PATH,
// a display, and xclip for the clipboard. Screenshots go to $RUNNER_TEMP/drive.
//   node --test scripts/drive.mjs
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

if (!process.env.CI) {
  console.error('drive.mjs runs in CI only: it uses your real app data and ends every terminal host');
  process.exit(1);
}

const APP = process.env.CODEBAER_APP ?? '/usr/bin/codebaer';
const DRIVER = 'http://127.0.0.1:4444';
const ROWS = '.term-host .xterm-rows > div';
const KEYS = { ctrl: '\uE009', shift: '\uE008', enter: '\uE007', escape: '\uE00C', end: '\uE010' };
const out = join(process.env.RUNNER_TEMP ?? tmpdir(), 'drive');
mkdirSync(out, { recursive: true });

/** A check that throws counts as not yet: a page still loading can fail a script, and xclip one read. */
async function until(what, fn, ms = 10_000) {
  const deadline = Date.now() + ms;
  let last;
  for (;;) {
    try {
      const got = await fn();
      if (got) return got;
    } catch (e) {
      last = e;
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}${last ? `: ${last.message}` : ''}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function call(method, path, body) {
  const res = await fetch(`${DRIVER}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${method} ${path}: ${JSON.stringify(json.value)}`);
  return json.value;
}

class App {
  /** `name` names the screenshot of its last screen, taken when it closes. */
  static async open(repo, name) {
    const caps = { alwaysMatch: { 'tauri:options': { application: APP, args: [repo] } } };
    const { sessionId } = await call('POST', '/session', { capabilities: caps });
    const app = new App(`/session/${sessionId}`, name);
    // the editor is there from the start; the hunk counter only once the repo is open
    await until('the review screen', () => app.shows('hunk 1 of'));
    return app;
  }

  constructor(base, name) {
    this.base = base;
    this.name = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }

  /** Ending the session kills the app, which leaves its host and sessions running as a rebuild would. They go
   *  too, so the next test's app cannot reattach to them, nor find this one still holding single-instance. The app
   *  may already be gone, which is what the quit test is for. */
  async close() {
    await this.shot(`${this.name}-end`).catch(() => {});
    await call('DELETE', this.base).catch(() => {});
    spawnSync('pkill', ['-f', '--', ' --pty-host ']);
    await until('the app, its host and its sessions to end', () => !running() && tagged().length === 0);
  }

  run(script, ...args) {
    return call('POST', `${this.base}/execute/sync`, { script, args });
  }

  has(css) {
    return this.run('return document.querySelector(arguments[0]) !== null', css);
  }

  shows(text) {
    return this.run('return document.body.innerText.includes(arguments[0])', text);
  }

  /** The terminal's rows as it renders them, one string each. */
  rows() {
    return this.run(`return [...document.querySelectorAll('${ROWS}')].map((r) => r.textContent)`);
  }

  /** Clicks the middle of the first element `css` matches, `count` times in a row, as a double or triple click. By
   *  position: WebKitWebDriver calls xterm's rows not interactable, since its screen layer takes the mouse. */
  async click(css, count = 1) {
    const at = await this.run(`const r = document.querySelector(arguments[0]).getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };`, css);
    const click = [{ type: 'pointerDown', button: 0 }, { type: 'pointerUp', button: 0 }];
    const actions = [
      { type: 'pointerMove', origin: 'viewport', ...at },
      ...Array.from({ length: count }, () => click).flat(),
    ];
    await call('POST', `${this.base}/actions`, {
      actions: [{ type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' }, actions }],
    });
  }

  /** One chord: every key goes down in order, then up in reverse. */
  async press(...keys) {
    const values = keys.map((k) => KEYS[k] ?? k);
    const actions = [
      ...values.map((value) => ({ type: 'keyDown', value })),
      ...[...values].reverse().map((value) => ({ type: 'keyUp', value })),
    ];
    await call('POST', `${this.base}/actions`, { actions: [{ type: 'key', id: 'keyboard', actions }] });
  }

  async type(text) {
    const actions = [...text].flatMap((value) => [{ type: 'keyDown', value }, { type: 'keyUp', value }]);
    await call('POST', `${this.base}/actions`, { actions: [{ type: 'key', id: 'keyboard', actions }] });
  }

  async shot(name) {
    writeFileSync(join(out, `${name}.png`), Buffer.from(await call('GET', `${this.base}/screenshot`), 'base64'));
  }

  /** A new terminal, once it is the one shown and its shell has printed a prompt. */
  async terminal() {
    const count = () => this.run("return document.querySelectorAll('.rail .rail-b:not(.new)').length");
    const before = await count();
    await this.press('ctrl', 't');
    await until('the new session', async () => (await count()) > before);
    await until('a prompt', async () => (await this.rows()).some((r) => r.trim() !== ''));
  }
}

/** A repo with one file changed in two places, far enough apart to be two hunks. */
function repo() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'drive-')));
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  const file = join(dir, 'a.txt');
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
  git('init', '-q');
  writeFileSync(file, `${lines.join('\n')}\n`);
  git('add', 'a.txt');
  git('-c', 'user.name=drive', '-c', 'user.email=drive@example.invalid', 'commit', '-qm', 'init');
  lines[2] = 'line three';
  lines[26] = 'line twenty-seven';
  writeFileSync(file, `${lines.join('\n')}\n`);
  return { dir, git, file };
}

/** What `read` gives for every process still readable, so one that ended mid-listing drops out. */
function processes(read) {
  return readdirSync('/proc').filter((pid) => /^\d+$/.test(pid)).flatMap((pid) => {
    try {
      return [read(pid)];
    } catch {
      return [];
    }
  });
}

/** Every process a session started carries its tag. */
const tagged = () => processes((pid) => readFileSync(`/proc/${pid}/environ`, 'latin1').split('\0'))
  .filter((env) => env.some((v) => v.startsWith('CODEBAER_SESSION=')));

/** The app or a host, not counting a zombie nothing has reaped yet. */
const running = () => processes((pid) => /^\d+ \(codebaer\) [^Z]/.test(readFileSync(`/proc/${pid}/stat`, 'latin1')))
  .some(Boolean);

let driver;
before(async () => {
  driver = spawn('tauri-driver', [], { stdio: 'inherit' });
  await new Promise((resolve, reject) => driver.once('spawn', resolve).once('error', reject));
  await until('tauri-driver', () => fetch(`${DRIVER}/status`).then((r) => r.ok, () => false));
});
after(() => {
  driver?.kill();
  spawnSync('pkill', ['-f', '--', ' --pty-host ']);
});

test('accepts a hunk with Ctrl+Y and saves an edit with Ctrl+S', async (t) => {
  const r = repo();
  const app = await App.open(r.dir, t.name);
  try {
    await until('the first of two hunks', () => app.shows('hunk 1 of 2'));
    await app.shot('review');
    await app.press('ctrl', 'y');
    await until('the hunk to be staged', () => r.git('diff', '--cached', '--name-only').trim() === 'a.txt');
    assert.match(r.git('diff', '--cached'), /\+line three/);
    assert.doesNotMatch(r.git('diff', '--cached'), /twenty-seven/);

    await app.click('.cm-content');
    await app.press('end');
    await app.type(' mine');
    await app.press('ctrl', 's');
    await until('the edit on disk', () => readFileSync(r.file, 'utf8').includes(' mine'));
  } finally {
    await app.close();
  }
});

test('a terminal runs a command, and plain Ctrl reaches the shell', async (t) => {
  const app = await App.open(repo().dir, t.name);
  try {
    await app.terminal();
    await app.type('echo drive-one');
    await app.press('enter');
    await until('the output', async () => (await app.rows()).some((r) => r.trim() === 'drive-one'));
    // readline's previous-history, not the app's quick open
    await app.press('ctrl', 'p');
    await until('the recalled line', async () =>
      (await app.rows()).filter((r) => r.includes('echo drive-one')).length === 2);
    assert.equal(await app.has('.pal'), false, 'Ctrl+P opened the quick open over the terminal');
    await app.shot('terminal');
  } finally {
    await app.close();
  }
});

test('Ctrl+Shift+V pastes into a terminal and Ctrl+Shift+C copies from it', async (t) => {
  // xclip stays behind to serve the selection, so its output must not be a pipe anything waits on
  spawnSync('xclip', ['-selection', 'clipboard'], { input: 'echo drive-pasted', stdio: ['pipe', 'ignore', 'ignore'] });
  const app = await App.open(repo().dir, t.name);
  try {
    await app.terminal();
    await app.press('ctrl', 'shift', 'v');
    await app.press('enter');
    await until('the pasted command to run', async () =>
      (await app.rows()).some((r) => r.trim() === 'drive-pasted'));

    const row = await app.run(
      `return [...document.querySelectorAll('${ROWS}')].findIndex((r) => r.textContent.trim() === 'drive-pasted')`);
    await app.click(`${ROWS}:nth-child(${row + 1})`, 3);
    await app.press('ctrl', 'shift', 'c');
    await until('the copied line', () =>
      execFileSync('xclip', ['-o', '-selection', 'clipboard'], { encoding: 'utf8' }).trim() === 'drive-pasted');
  } finally {
    await app.close();
  }
});

test('Ctrl+Shift+P opens the palette and Ctrl+, opens Settings', async (t) => {
  const app = await App.open(repo().dir, t.name);
  try {
    await app.press('ctrl', 'shift', 'p');
    await until('the palette', () => app.has('.pal'));
    await app.shot('palette');
    await app.press('escape');
    await until('the palette to close', async () => !(await app.has('.pal')));
    await app.press('ctrl', ',');
    await until('Settings', () => app.has('[aria-label="Sections"]'));
    await app.shot('settings');
  } finally {
    await app.close();
  }
});

test('Ctrl+Q quits and leaves no host or session behind', async (t) => {
  const app = await App.open(repo().dir, t.name);
  try {
    await app.terminal();
    assert.notEqual(tagged().length, 0, 'the terminal has no tagged process');
    // out of the terminal, where Ctrl+Q is the shell's XON, and into the Files list
    await app.press('ctrl', 'shift', 'e');
    await until('the focus to leave the terminal', async () =>
      !(await app.run("return !!document.activeElement?.closest('.term-host')")));
    // the app can be gone before the driver answers the key press, and how the driver says so varies
    await app.press('ctrl', 'q').catch(() => {});
    await until('the app and its host to end', () => !running());
    await until('the sessions to end', () => tagged().length === 0);
  } finally {
    await app.close();
  }
});

test('logged no errors', () => {
  const dir = join(process.env.XDG_DATA_HOME ?? join(process.env.HOME, '.local/share'), 'com.codebaer.app/logs');
  const errors = readdirSync(dir).flatMap((f) => readFileSync(join(dir, f), 'utf8').split('\n')).filter((l) =>
    l.includes(' ERROR '));
  assert.deepEqual(errors, []);
});
