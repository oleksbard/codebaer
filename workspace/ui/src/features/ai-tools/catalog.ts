import type { AI_PROVIDERS } from '#ipc/settings';

export type Tool = {
  /** The provider id, which is also the CLI the backend looks for. */
  id: (typeof AI_PROVIDERS)[number];
  name: string;
  vendor: string;
  /** The logo's path from Simple Icons, on a 24 by 24 grid. Codex's is the `openai` entry, which the set now
   *  hides but still ships. */
  logo: string;
  blurb: string;
  openSource: boolean;
  /** The installer the vendor's own page gives first. */
  install: string;
  url: string;
};

export const TOOLS: readonly Tool[] = [
  {
    id: 'claude',
    name: 'Claude Code',
    vendor: 'Anthropic',
    logo: 'M21 10.5h3v3h-3v3h-1.5v3H18v-3h-1.5v3H15v-3H9v3H7.5v-3H6v3H4.5v-3H3v-3H0v-3h3v-6h18Z'
      + 'm-15 0h1.5v-3H6Zm10.5 0H18v-3h-1.5z',
    blurb: 'Runs on Claude models only. Needs a Claude subscription or an Anthropic API key.',
    openSource: false,
    install: 'curl -fsSL https://claude.ai/install.sh | bash',
    url: 'https://code.claude.com/docs/en/setup',
  },
  {
    id: 'codex',
    name: 'Codex CLI',
    vendor: 'OpenAI',
    logo: 'M22.282 9.821a6 6 0 0 0-.516-4.91a6.05 6.05 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a6 6 0 0 0-3.998 2.9'
      + 'a6.05 6.05 0 0 0 .743 7.097a5.98 5.98 0 0 0 .51 4.911a6.05 6.05 0 0 0 6.515 2.9A6 6 0 0 0 13.26 24'
      + 'a6.06 6.06 0 0 0 5.772-4.206a6 6 0 0 0 3.997-2.9a6.06 6.06 0 0 0-.747-7.073M13.26 22.43'
      + 'a4.48 4.48 0 0 1-2.876-1.04l.141-.081l4.779-2.758a.8.8 0 0 0 .392-.681v-6.737l2.02 1.168a.07.07 0 0 1 .038.052'
      + 'v5.583a4.504 4.504 0 0 1-4.494 4.494M3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085l4.783 2.759'
      + 'a.77.77 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646M2.34 7.896'
      + 'a4.5 4.5 0 0 1 2.366-1.973V11.6a.77.77 0 0 0 .388.677l5.815 3.354l-2.02 1.168a.08.08 0 0 1-.071 0l-4.83-2.786'
      + 'A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.119 7.2a.08.08 0 0 1 .071 0l4.83 2.791'
      + 'a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667m2.01-3.023l-.141-.085l-4.774-2.782'
      + 'a.78.78 0 0 0-.785 0L9.409 9.23V6.897a.07.07 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135'
      + 'l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.8.8 0 0 0-.393.681z'
      + 'm1.097-2.365l2.602-1.5l2.607 1.5v2.999l-2.597 1.5l-2.607-1.5Z',
    blurb: 'Runs commands in a sandbox and asks before it leaves it. Sign in with ChatGPT or use an OpenAI API key.',
    openSource: true,
    install: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh',
    url: 'https://github.com/openai/codex',
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    vendor: 'Anomaly',
    logo: 'M22 24H2V0h20zM17 4.8H7v14.4h10z',
    blurb: 'Works with models from many providers, local ones included. Use an API key from any of them.',
    openSource: true,
    install: 'curl -fsSL https://opencode.ai/install | bash',
    url: 'https://opencode.ai/download',
  },
];
