import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const LEVELS = ['major', 'minor', 'patch'];

const PATTERNS = {
  toml: [/^(\[package\]\n(?:(?!\[)[^\n]*\n)*?version = ")([^"\n]*)"/m, 'Cargo.toml'],
  lock: [/^(name = "codebaer"\nversion = ")([^"\n]*)"/m, 'Cargo.lock'],
};

const parse = (v) => {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  if (!m) throw new Error(`not a plain x.y.z version: ${v}`);
  return m.slice(1).map(Number);
};

const compare = (a, b) => {
  const [x, y] = [parse(a), parse(b)];
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
};

/** The version a change of `level` needs, counted from the last release, so a bump already pending in
 *  `current` is kept when it is at least as big. Nothing released yet means `current` is still unshipped. */
export function nextVersion(current, released, level) {
  const i = LEVELS.indexOf(level);
  if (i < 0) throw new Error(`level must be one of ${LEVELS.join(', ')}, got ${level}`);
  parse(current);
  if (released === null) return current;
  const need = parse(released).map((n, j) => (j < i ? n : j === i ? n + 1 : 0)).join('.');
  return compare(current, need) >= 0 ? current : need;
}

export function setVersion(text, version, kind) {
  const [re, file] = PATTERNS[kind];
  if (!re.test(text)) throw new Error(`no codebaer version line in ${file}`);
  return text.replace(re, `$1${version}"`);
}

// Publishing a release creates its tag on GitHub, so local tags can be behind until the next fetch,
// and counting from them could keep a version that is already out. Hence origin or nothing.
function lastRelease() {
  let out;
  try {
    out = execFileSync('git', ['ls-remote', '--tags', '--refs', 'origin', 'v*'], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'],
      env: { GIT_SSH_COMMAND: 'ssh -o BatchMode=yes', ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
  } catch {
    throw new Error('cannot reach origin to find the last release; nothing was changed');
  }
  const versions = out.split('\n').map((l) => /refs\/tags\/v(\d+\.\d+\.\d+)$/.exec(l.trim())?.[1]);
  return versions.filter((v) => v !== undefined).sort(compare).at(-1) ?? null;
}

function main() {
  const level = process.argv[2];
  if (!LEVELS.includes(level)) throw new Error('usage: pnpm bump patch|minor|major');
  const toml = fileURLToPath(new URL('../src-tauri/Cargo.toml', import.meta.url));
  const lock = fileURLToPath(new URL('../src-tauri/Cargo.lock', import.meta.url));
  const text = readFileSync(toml, 'utf8');
  const current = PATTERNS.toml[0].exec(text)?.[2];
  if (current === undefined) throw new Error('no package version in Cargo.toml');
  const released = lastRelease();
  const next = nextVersion(current, released, level);
  if (next === current) {
    console.log(`bump: keeping ${current}, last release ${released === null ? 'none' : `v${released}`}`);
    return;
  }
  const texts = [setVersion(text, next, 'toml'), setVersion(readFileSync(lock, 'utf8'), next, 'lock')];
  writeFileSync(toml, texts[0]);
  writeFileSync(lock, texts[1]);
  console.log(`bump: ${current} -> ${next}`);
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (e) {
    console.error(`bump: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
