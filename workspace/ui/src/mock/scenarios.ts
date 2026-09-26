import type { AiProvider, CustomCommand } from '#ipc/settings';
import type { Menu, Orphans, Proc } from '#ipc/terminal';
import type { SessionSeed } from './pty';
import type { FileSeed, RepoSeed } from './repo';

export type Scenario = {
  root: string;
  /** What `initial_repo` answers, as if the app had been launched on a folder. */
  initial: string | null;
  /** What the native folder picker answers; null is a cancel. */
  pick: string | null;
  gitMissing: boolean;
  repo: RepoSeed;
  recents: string[];
  commands: CustomCommand[];
  ai: AiProvider;
  menu: Menu;
  sessions: SessionSeed[];
  orphans: Orphans;
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
  commands: ['claude', 'codex', 'node', 'python3', 'bun'],
};

const REPO: RepoSeed = {
  files: {
    ...UNCHANGED,
    'src/cart.ts': { head: CART_HEAD, work: CART_WORK },
    'src/checkout.ts': { head: CHECKOUT_HEAD, index: CHECKOUT_INDEX, work: CHECKOUT_WORK },
    'src/money.ts': { head: MONEY, work: null },
    'src/utils/money.ts': { work: MONEY_NEW },
    'tools/release.cmd': { head: RELEASE, work: RELEASE.replace('pnpm build', 'pnpm test\npnpm build'), eol: 'crlf' },
    'static/logo.png': { head: 'PNG v1', work: 'PNG v2', kind: 'binary' },
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
    repo: REPO,
    recents: [ROOT, '/Users/dev/projects/website', '/Users/dev/oss/tiny-router'],
    commands: [
      { name: 'Type check', command: 'pnpm exec tsc --noEmit', repo: null, hide_terminal: false },
      { name: 'Format', command: 'pnpm format', repo: ROOT, hide_terminal: true },
    ],
    ai: 'claude',
    menu: MENU,
    sessions: [
      { pid: 50_001, title: 'zsh', tier: 'marks', state: { t: 'Idle' }, transcript: SHELL_TRANSCRIPT },
      {
        pid: 50_002, title: 'claude', tier: 'process', state: { t: 'Running', command: null, since_ms: ago(95) },
        transcript: AGENT_TRANSCRIPT,
      },
    ],
    orphans: NO_ORPHANS,
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

/** Built per call: each backend mutates its own copy, and `since_ms` counts from page load. */
export const SCENARIOS: Record<string, () => Scenario> = {
  review,

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

  'no-repo': () => ({ ...review(), initial: null, pick: null, sessions: [] }),

  'no-git': () => ({ ...review(), gitMissing: true }),
};
