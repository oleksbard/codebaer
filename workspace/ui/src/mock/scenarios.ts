import type { Update } from '#ipc/git';
import type { AiProvider, CustomCommand } from '#ipc/settings';
import type { Menu, Orphans, Proc } from '#ipc/terminal';
import { idleAgent, type SessionSeed } from './pty';
import type { FileSeed, RepoSeed } from './repo';

export type Scenario = {
  root: string;
  /** What `initial_repo` answers, as if the app had been launched on a folder. */
  initial: string | null;
  /** What the native folder picker answers; null is a cancel. */
  pick: string | null;
  gitMissing: boolean;
  /** The root has no repository until `git_init` runs; the seed's repo is what the init then finds. */
  plain: boolean;
  repo: RepoSeed;
  recents: string[];
  favorites: string[];
  commands: CustomCommand[];
  ai: AiProvider;
  menu: Menu;
  sessions: SessionSeed[];
  orphans: Orphans;
  /** null for a build that does not update itself, as every build but main's macOS packages; else what a check
   *  finds, with null for nothing newer. */
  updates: { found: Update | null } | null;
};

const ROOT = '/Users/dev/projects/acme-shop';

const README = `# Acme Shop

A small storefront, here so CodeBär has something to show in browser mode.
`;

const PACKAGE = `{
  "name": "acme-shop",
  "private": true,
  "packageManager": "pnpm@10.12.0",
  "scripts": {
    "build": "tsc && vite build",
    "dev": "vite",
    "lint": "oxlint src",
    "test": "vitest run"
  }
}
`;

const CART_HEAD = `import { formatMoney } from './money';

export type LineItem = { sku: string; name: string; price: number; qty: number };

export type Cart = { items: LineItem[]; coupon: string | null };

export const emptyCart = (): Cart => ({ items: [], coupon: null });

export function addItem(cart: Cart, item: LineItem): Cart {
  const existing = cart.items.find((i) => i.sku === item.sku);
  if (existing) {
    return {
      ...cart,
      items: cart.items.map((i) => (i.sku === item.sku ? { ...i, qty: i.qty + item.qty } : i)),
    };
  }
  return { ...cart, items: [...cart.items, item] };
}

export function removeItem(cart: Cart, sku: string): Cart {
  return { ...cart, items: cart.items.filter((i) => i.sku !== sku) };
}

export function subtotal(cart: Cart): number {
  let total = 0;
  for (const item of cart.items) {
    total += item.price * item.qty;
  }
  return total;
}

export function itemCount(cart: Cart): number {
  return cart.items.reduce((n, i) => n + i.qty, 0);
}

export function summary(cart: Cart): string {
  return \`\${itemCount(cart)} items, \${formatMoney(subtotal(cart))}\`;
}
`;

const CART_WORK = CART_HEAD
  .replace("from './money'", "from './utils/money'")
  .replace('qty: number };', 'qty: number; discount?: number };')
  .replace(`  let total = 0;
  for (const item of cart.items) {
    total += item.price * item.qty;
  }
  return total;`, '  return cart.items.reduce((sum, i) => sum + (i.price - (i.discount ?? 0)) * i.qty, 0);')
  .replace('  return `${itemCount(cart)} items, ', `  const n = itemCount(cart);
  return \`\${n} \${n === 1 ? 'item' : 'items'}, `);

const CHECKOUT_HEAD = `import { type Cart, subtotal } from './cart';

const TAX_RATE = 0.2;

export function tax(cart: Cart): number {
  return subtotal(cart) * TAX_RATE;
}

export function total(cart: Cart): number {
  return subtotal(cart) + tax(cart);
}

export function canCheckout(cart: Cart): boolean {
  return cart.items.length > 0;
}
`;
const CHECKOUT_INDEX = CHECKOUT_HEAD.replace('TAX_RATE = 0.2;', 'TAX_RATE = 0.19;');
const CHECKOUT_WORK = CHECKOUT_INDEX
  .replace('cart.items.length > 0;', 'cart.items.length > 0 && cart.items.every((i) => i.qty <= 10);');

const MONEY = `const formatter = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

export const formatMoney = (cents: number): string => formatter.format(cents / 100);
`;
const MONEY_NEW = `${MONEY}
export const roundCents = (value: number): number => Math.round(value);
`;

const RELEASE = '@echo off\npnpm install --frozen-lockfile\npnpm build\n';

/** Base64, the form the mock keeps a binary file in: the logo before and after the agent recoloured it. */
const LOGO_HEAD = 'iVBORw0KGgoAAAANSUhEUgAAAKAAAAB4CAYAAAB1ovlvAAAB5klEQVR42u3duxHCMBBAQYqiFIZaKICC6BByEsDY99Htm3Esi9tR'
  + 'hnU6SZIkSZIkSZIkSZIkSZIkSdO6Xc/Pbx/7VcogVhjMtP0uO4yOQ5m23+WH0Wko0/Y7ZhhbhtJxPQgL4/s0lCPXzFybpkL43ocS'
  + 'sVaFd6CqGMBpD1XwQQgggGoE8HG//P0ACGA4uqoY6SoM8Eh4VSDSVRBgJLxsiHQVApgJLwsiXQUAVoIXDZGuZICV8UUgpCsRYAd8'
  + 'RyOkKwFgJ3hHQ6QrGGFnfHsjpCoY4Ar49kRIVTBCAOFLQ7gSvn8RUhSMcEV8WxHSE4xwZXy/IqQmASGA8KUhnIDvG4SUAAggfBAK'
  + 'QAAnAJyI7xNCWpx+TkGnn1NQAAIIIICCD0IAARSAAAIIoAAEEEAABSCAAAIoAAEEEEABCCCAAApAAAEEUAACCCCAAAIIIITwAQgg'
  + 'gAACCCCE/hfsFHT6AejbMAACCCCEvg8IH4AAQgifAAQQQviUBXDqTUlUQAgfhPMAUgAhfADOvDHd9Jsg7AbRfXAQwqd5COEbgrAa'
  + 'RHcAD0WYDdHt5xCmQPz13UwTRPAUh3BPjFvXNjUI0x7TAhE8zYFoGiCCpxkY/coKBelXlCRJkiRJkiRJkiRJkiRJkiRJ0kq9ACTc'
  + 'yuLMCmtrAAAAAElFTkSuQmCC';
const LOGO_WORK = 'iVBORw0KGgoAAAANSUhEUgAAAKAAAAB4CAYAAAB1ovlvAAACKElEQVR42u3dwW0DIRBAUZeTSlJEinBNOeecwtKBc48i7S4LzMC8'
  + 'L3HGhCfWkh3zeEiSJEmSJEmSJEmSJEmSJEnV+ny+vc4O61XIRuywMdXWu+1mrLgp1da7/WastCnV1ltmM1o2ZcX5IEyM72hTRs4Z'
  + 'OTdNifD93ZQZc2V4DVQlA1htUAUfhAACqIUA/ny/3x4AAjgdXVaMdCUGOBJeFoh0JQQ4E140RLoSAYyEFwWRrgQAM8GbDZGuYICZ'
  + '8c1ASFcgwBXwjUZIVwDAleCNhkjXZIQr4+uNkKrJAHfA1xMhVZMRAghfGMKd8N1FSNFkhDvia0VIz2SEO+O7ipCaAIQAwheGsAK+'
  + 'MwgpARBA+CAUgABWAFgR3xFCWpx+TkGnn1NQAAIIIICCD0IAARSAAAIIoAAEEEAABSCAAAIoAAEEEEABCCCAAApAAAEEUAACCCCA'
  + 'AAIIIITwAQgggAACCCCE/i/YKej0A9BvwwAIIIAQ+n1A+AAEEEL4BCCAEMKnKIBVb0r67+/08fV8HQ2aIAzDB6FHcfdH7xV4IELY'
  + '/X0fgB7FYY/eO/ggHIhwNYgt98H1wAchhM2XEQIIYehNmAAuhDAbxB53AAO4IMJoiD1vPwdwYYSzIV59bWfWCyCIIfAA3BBhT4yt'
  + 'c19dI4CbIowYLesDEMQQeD4JATEcXi+EVBSDOGI9AMKY4pvL4AEZ/lV5+CRJkiRJkiRJkiRJkiRJkiRJktS7X2A+1zv8DkwlAAAA'
  + 'AElFTkSuQmCC';

const UNCHANGED: Record<string, FileSeed> = {
  '.gitignore': { head: 'node_modules/\ndist/\n' },
  'README.md': { head: README },
  'package.json': { head: PACKAGE },
  'tsconfig.json': { head: '{\n  "compilerOptions": { "strict": true, "target": "ES2022" }\n}\n' },
  'src/index.ts': { head: "export * from './cart';\nexport * from './checkout';\n" },
  'src/api/client.ts': { head: "export const api = (path: string) => fetch(`/api/${path}`).then((r) => r.json());\n" },
  'src/cart.test.ts': {
    head: "import { expect, test } from 'vitest';\nimport { emptyCart, itemCount } from './cart';\n\n"
      + "test('an empty cart has no items', () => {\n  expect(itemCount(emptyCart())).toBe(0);\n});\n",
  },
};

const MENU: Menu = {
  shells: [{ path: '/bin/zsh', name: 'zsh' }, { path: '/bin/bash', name: 'bash' }],
  default: '/bin/zsh',
  commands: ['claude', 'codex', 'opencode', 'node', 'python3', 'bun'],
};

const REPO: RepoSeed = {
  files: {
    ...UNCHANGED,
    'src/cart.ts': { head: CART_HEAD, work: CART_WORK },
    'src/checkout.ts': { head: CHECKOUT_HEAD, index: CHECKOUT_INDEX, work: CHECKOUT_WORK },
    'src/money.ts': { head: MONEY, work: null },
    'src/utils/money.ts': { work: MONEY_NEW },
    'tools/release.cmd': { head: RELEASE, work: RELEASE.replace('pnpm build', 'pnpm test\npnpm build'), eol: 'crlf' },
    'static/logo.png': { head: LOGO_HEAD, work: LOGO_WORK, kind: 'binary' },
  },
  branch: 'cart-discounts',
  upstream: 'origin/cart-discounts',
  ahead: 1,
  behind: 0,
  branches: [
    { kind: 'local', name: 'main' },
    { kind: 'local', name: 'cart-discounts' },
    { kind: 'remote', remote: 'origin', branch: 'main' },
    { kind: 'remote', remote: 'origin', branch: 'cart-discounts' },
    { kind: 'remote', remote: 'origin', branch: 'release-1.4' },
  ],
  ignored: ['dist/', 'node_modules/'],
  dirs: {
    'dist': ['dist/assets/', 'dist/index.html'],
    'node_modules': ['node_modules/.pnpm/', 'node_modules/typescript/', 'node_modules/vite/'],
  },
  log: ['Show the item count in the cart summary', 'Add a coupon field to the cart', 'Set up the storefront'],
};

const SHELL_TRANSCRIPT = '\x1b[32macme-shop\x1b[0m \x1b[90mcart-discounts\x1b[0m $ pnpm test\n'
  + ' \x1b[32m✓\x1b[0m src/cart.test.ts (1 test) 3ms\n\n Test Files  1 passed (1)\n      Tests  1 passed (1)\n\n'
  + '\x1b[32macme-shop\x1b[0m \x1b[90mcart-discounts\x1b[0m $ ';

const AGENT_TRANSCRIPT = '\x1b[38;5;208m✻\x1b[0m Welcome to Claude Code\n\n'
  + '\x1b[35m>\x1b[0m Add per-item discounts to the cart and move money formatting into utils\n\n'
  + '\x1b[36m⏺\x1b[0m I will add a discount to LineItem, use it in subtotal, and move money.ts.\n'
  + '\x1b[36m⏺\x1b[0m Update(src/cart.ts)\n'
  + '\x1b[36m⏺\x1b[0m Write(src/utils/money.ts)\n'
  + '\x1b[36m⏺\x1b[0m Done. Review the changes in CodeBär.\n\n\x1b[35m>\x1b[0m ';

const ago = (s: number): number => Date.now() - s * 1000;
const EDITING = { id: 't4', tool: 'Edit', detail: `${ROOT}/src/cart.ts`, since_ms: ago(3) };

const proc = (pid: number, session: number, command: string): Proc => ({
  pid, ppid: 4242, pgid: pid, tty: `ttys00${session}`, command, session, relay: null, holds_app: false, exiting: false,
});

const NO_ORPHANS: Orphans = { sock: '/tmp/codebaer-501/pty.sock', hosts: [], escaped: [] };

function review(): Scenario {
  return {
    root: ROOT,
    initial: ROOT,
    pick: ROOT,
    gitMissing: false,
    plain: false,
    repo: REPO,
    recents: [ROOT, '/Users/dev/projects/website', '/Users/dev/oss/tiny-router'],
    favorites: ['/Users/dev/oss/tiny-router'],
    commands: [
      { name: 'Type check', command: 'pnpm exec tsc --noEmit', repo: null, hide_terminal: false, icon: null },
      { name: 'Format', command: 'pnpm format', repo: ROOT, hide_terminal: true, icon: null },
    ],
    ai: 'claude',
    menu: MENU,
    sessions: [
      { pid: 50_001, title: 'zsh', tier: 'marks', state: { t: 'Idle' }, transcript: SHELL_TRANSCRIPT },
      {
        pid: 50_002, title: 'claude', tier: 'process', state: { t: 'Running', command: null, since_ms: ago(95) },
        transcript: AGENT_TRANSCRIPT,
        agent: {
          ...idleAgent(ago(95)), phase: 'working', turn_ms: ago(95), actions: 4, calls: [EDITING], last: EDITING,
        },
      },
    ],
    orphans: NO_ORPHANS,
    updates: null,
  };
}

const VIDEO_HOME = '/Users/dev';
const VIDEO_ROOT = `${VIDEO_HOME}/projects/plant-shop`;

const VIDEO_CART_HEAD = `export type LineItem = {
  sku: string;
  price: number;
  discount: number;
  qty: number;
};

export function subtotal(items: LineItem[]): number {
  return items.reduce((sum, i) => sum + i.price * i.qty, 0);
}

export function itemCount(items: LineItem[]): number {
  return items.reduce((n, i) => n + i.qty, 0);
}
`;
const VIDEO_CART_WORK = VIDEO_CART_HEAD.replace(
  '  return items.reduce((sum, i) => sum + i.price * i.qty, 0);',
  `  return items.reduce((sum, i) => {
    const net = i.price - i.discount;
    return sum + net * i.qty;
  }, 0);`,
);

const VIDEO_CHECKOUT_HEAD = `import { type LineItem, subtotal } from './cart';

const TAX_RATE = 0.19;

export function total(items: LineItem[]): number {
  return subtotal(items) * (1 + TAX_RATE);
}

export function canCheckout(items: LineItem[]): boolean {
  return items.length > 0;
}
`;
const VIDEO_CHECKOUT_WORK = VIDEO_CHECKOUT_HEAD.replace(
  'boolean {\n  return items.length > 0;',
  'boolean {\n  if (items.some((i) => i.qty > 10)) return false;\n  return items.length > 0;',
);

const VIDEO_REPO: RepoSeed = {
  files: {
    '.gitignore': { head: 'node_modules/\ndist/\n' },
    'README.md': { head: '# Plant Shop\n\nHouseplants, delivered.\n' },
    'package.json': { head: PACKAGE.replace('acme-shop', 'plant-shop') },
    'tsconfig.json': { head: '{\n  "compilerOptions": { "strict": true, "target": "ES2022" }\n}\n' },
    'src/index.ts': { head: "export * from './cart';\nexport * from './checkout';\n" },
    'src/cart.ts': { head: VIDEO_CART_HEAD, work: VIDEO_CART_WORK },
    'src/checkout.ts': { head: VIDEO_CHECKOUT_HEAD, work: VIDEO_CHECKOUT_WORK },
  },
  branch: 'item-discounts',
  upstream: 'origin/item-discounts',
  ahead: 0,
  behind: 0,
  branches: [
    { kind: 'local', name: 'main' },
    { kind: 'local', name: 'item-discounts' },
    { kind: 'remote', remote: 'origin', branch: 'main' },
    { kind: 'remote', remote: 'origin', branch: 'item-discounts' },
  ],
  ignored: ['dist/', 'node_modules/'],
  dirs: { 'dist': ['dist/index.html'], 'node_modules': ['node_modules/.pnpm/', 'node_modules/typescript/'] },
  log: ['Add the cart and checkout', 'Set up the storefront'],
};

const dim = (s: string): string => `\x1b[2m${s}\x1b[0m`;
const grey = (s: string): string => `\x1b[90m${s}\x1b[0m`;
const BANNER_WIDTH = 54;
const bannerRow = (plain: string, styled = plain): string =>
  `${grey('│')} ${styled}${' '.repeat(BANNER_WIDTH - 1 - plain.length)}${grey('│')}`;
const dimRow = (plain: string): string => bannerRow(plain, dim(plain));

const VIDEO_AGENT_TRANSCRIPT = [
  grey(`╭${'─'.repeat(BANNER_WIDTH)}╮`),
  bannerRow('✻ Welcome to Claude Code', '✻ Welcome to \x1b[1mClaude Code\x1b[0m'),
  bannerRow(''),
  dimRow('  /help for help, /status for your current setup'),
  bannerRow(''),
  dimRow(`  cwd: ${VIDEO_ROOT.replace(VIDEO_HOME, '~')}`),
  grey(`╰${'─'.repeat(BANNER_WIDTH)}╯`),
  '',
  '\x1b[36m>\x1b[0m Apply per-item discounts to the cart total.',
  '',
  "⏺ I'll apply each item's discount when the cart total is computed.",
  '',
  '\x1b[32m⏺\x1b[0m \x1b[1mUpdate\x1b[0m(src/cart.ts)',
  dim('  ⎿  Updated src/cart.ts with 4 additions and 1 removal'),
  '',
  '\x1b[32m⏺\x1b[0m \x1b[1mUpdate\x1b[0m(src/checkout.ts)',
  dim('  ⎿  Updated src/checkout.ts with 1 addition'),
  '',
  "⏺ Done. subtotal() now subtracts each item's discount.",
  '',
  '\x1b[36m>\x1b[0m ',
].join('\n');

/** The promo video's one repo and story: asked for discounts, the agent also limited checkout to 10 units. */
function video(): Scenario {
  return {
    root: VIDEO_ROOT,
    initial: VIDEO_ROOT,
    pick: VIDEO_ROOT,
    gitMissing: false,
    plain: false,
    repo: VIDEO_REPO,
    recents: [VIDEO_ROOT],
    favorites: [],
    commands: [],
    ai: 'claude',
    menu: MENU,
    sessions: [
      { pid: 50_001, title: 'claude', tier: 'process', state: { t: 'Idle' }, transcript: VIDEO_AGENT_TRANSCRIPT },
      { pid: 50_002, title: 'codex', tier: 'process', state: { t: 'Idle' }, transcript: '\x1b[36m>\x1b[0m ' },
      { pid: 50_003, title: 'opencode', tier: 'process', state: { t: 'Idle' }, transcript: '\x1b[36m>\x1b[0m ' },
    ],
    orphans: NO_ORPHANS,
    updates: null,
  };
}

/** Every file as its worktree version, committed: what the repo looks like once the review is done. */
const committed = (files: Record<string, FileSeed>): Record<string, FileSeed> => Object.fromEntries(
  Object.entries(files).flatMap(([p, f]) => {
    const index = f.index === undefined ? f.head : f.index;
    const final = f.work === undefined ? index : f.work;
    return final === null || final === undefined ? [] : [[p, { head: final, eol: f.eol ?? 'lf' }]];
  }),
);

const CONFLICTED_CART = CART_HEAD.replace(`  let total = 0;
  for (const item of cart.items) {
    total += item.price * item.qty;
  }
  return total;`, `<<<<<<< HEAD
  let total = 0;
  for (const item of cart.items) {
    total += item.price * item.qty;
  }
  return total;
=======
  return cart.items.reduce((sum, i) => sum + i.price * i.qty, 0);
>>>>>>> origin/main`);

const AREAS = ['components', 'hooks', 'services', 'utils', 'models', 'pages', 'api', 'store'];

/** Deterministic, so a test can name a path: `<kind>/<kind>-<p>/src/<area>/<area>-<d>/file-<f>.ts`. */
function monorepo(): Pick<RepoSeed, 'files' | 'ignored' | 'dirs'> {
  const files: Record<string, FileSeed> = {};
  const ignored: string[] = [];
  const dirs: Record<string, string[]> = {};
  for (const kind of ['apps', 'packages']) {
    for (let p = 0; p < 25; p++) {
      const pkg = `${kind}/${kind}-${p}`;
      files[`${pkg}/package.json`] = { head: `{ "name": "@acme/${kind}-${p}" }\n` };
      for (const area of AREAS) {
        for (let d = 0; d < 12; d++) {
          for (let f = 0; f < 10; f++) {
            const name = `${area}${d}x${f}`;
            files[`${pkg}/src/${area}/${area}-${d}/file-${f}.ts`] = {
              head: `import { shared } from '@acme/core';\n\nexport function ${name}(n: number): number {\n`
                + `  return shared(n) + ${p * 1000 + d * 10 + f};\n}\n`,
            };
          }
        }
      }
      ignored.push(`${pkg}/node_modules/`, `${pkg}/dist/`, `${pkg}/.turbo/`, `${pkg}/coverage/`, `${pkg}/.next/`);
      dirs[`${pkg}/node_modules`] = Array.from({ length: 400 }, (_, i) => `${pkg}/node_modules/dep-${i}/`);
    }
  }
  return { files, ignored, dirs };
}

/** Built per call: each backend mutates its own copy, and `since_ms` counts from page load. */
export const SCENARIOS: Record<string, () => Scenario> = {
  review,

  video,

  clean: () => {
    const s = review();
    return {
      ...s,
      repo: { ...s.repo, files: committed(s.repo.files), branch: 'main', upstream: 'origin/main', ahead: 0 },
      sessions: [],
    };
  },

  conflict: () => {
    const s = review();
    return {
      ...s,
      repo: {
        ...s.repo,
        files: {
          ...UNCHANGED,
          'src/cart.ts': { head: CART_HEAD, work: CONFLICTED_CART, conflicted: true },
          'src/checkout.ts': { head: CHECKOUT_HEAD, work: CHECKOUT_WORK },
          'src/data/catalog.json': { head: '[]\n', work: '[{}]\n', kind: 'large' },
        },
        branch: 'main',
        upstream: 'origin/main',
        ahead: 0,
        behind: 2,
      },
    };
  },

  terminals: () => {
    const s = review();
    return {
      ...s,
      sessions: [
        ...s.sessions,
        {
          pid: 50_003, title: 'bash', tier: 'marks', state: { t: 'Exited', code: 1 },
          transcript: '$ make\nmake: *** No targets specified and no makefile found.  Stop.\n',
        },
        {
          pid: 50_004, title: 'zsh', tier: 'marks', state: { t: 'Running', command: 'pnpm dev', since_ms: ago(620) },
          transcript: '$ pnpm dev\n\n  VITE v8.3.0  ready in 212 ms\n\n  ➜  Local:   http://localhost:5173/\n',
        },
        {
          pid: 50_005, title: 'claude', tier: 'process', state: { t: 'Idle' }, cwd: '/Users/dev/projects/blog',
          transcript: AGENT_TRANSCRIPT,
          agent: {
            ...idleAgent(ago(12)), phase: 'approval', turn_ms: ago(40), actions: 2,
            ask: { id: 't3', tool: 'Bash', detail: 'Build the blog for production', since_ms: ago(12) },
          },
        },
        {
          pid: 50_006, title: 'zsh', tier: 'marks', state: { t: 'Idle' }, cwd: '/Users/dev/projects/website/src/pages',
          transcript: SHELL_TRANSCRIPT,
        },
      ],
      orphans: {
        sock: NO_ORPHANS.sock,
        hosts: [{
          pid: 4242, sock: '/tmp/codebaer-501/pty-1.sock', current: false, sock_exists: true, in_use: false,
          unclear: false, proto: 2, relays: [], sessions: [proc(4250, 1, '/bin/zsh -l'), proc(4251, 2, 'claude')],
        }],
        escaped: [],
      },
    };
  },

  // Codex and OpenCode missing, for the AI tools dialog
  'claude-only': () => ({ ...review(), menu: { ...MENU, commands: ['claude', 'node', 'python3', 'bun'] } }),

  'no-repo': () => ({ ...review(), initial: null, pick: null, sessions: [] }),

  'no-git': () => ({ ...review(), gitMissing: true }),

  // a project folder with no repository: the terminals and tasks work, the review waits for Git: Init Repository
  plain: () => ({ ...review(), plain: true }),

  // a monorepo of about 50,000 files and 500 ignored folders, for the Files and Search performance
  big: () => {
    const s = review();
    const { files, ignored, dirs } = monorepo();
    return {
      ...s,
      repo: {
        ...s.repo,
        files: { ...s.repo.files, ...files },
        ignored: [...s.repo.ignored, ...ignored],
        dirs: { ...s.repo.dirs, ...dirs },
      },
    };
  },

  // a release is out: Check for Updates… in the palette finds it
  update: () => ({
    ...review(),
    updates: {
      found: {
        version: '0.6.0', page: 'https://github.com/oleksbard/codebaer/releases/tag/v0.6.0', keeps_terminals: true,
      },
    },
  }),
};
