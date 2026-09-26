import { AI_PROVIDERS, type SettingKey, type Settings } from '#ipc/settings';
import { aiUses } from '#kernel/registry';
import { S } from '#kernel/store';
import { THEMES } from '#ui/theme';

export type Choice<K extends SettingKey> = { value: Settings[K]; label: string };
export type Option = {
  [K in SettingKey]: {
    key: K; label: string; description: string; choices: Choice<K>[];
    /** What depends on the option, read when the row renders so the list follows the registered features. */
    uses?(): { label: string; icon: string }[];
    /** Choices that cannot be picked right now, with the reason, keyed by value. */
    unavailable?(): ReadonlyMap<string, string>;
  };
}[SettingKey];
export type Section = { id: string; label: string; options: Option[] };

export const SECTIONS: Section[] = [
  {
    id: 'general',
    label: 'General',
    options: [
      {
        key: 'general.headless-ai-provider',
        label: 'Headless AI provider',
        description: 'The AI command-line tool that the app runs in the background, without a terminal. '
          + 'It must be installed. Off turns off everything that uses it.',
        choices: [
          { value: 'off', label: 'Off' }, { value: 'claude', label: 'Claude' }, { value: 'codex', label: 'Codex' },
          { value: 'opencode', label: 'OpenCode' },
        ],
        uses: aiUses,
        unavailable: () => new Map(AI_PROVIDERS.filter((p) => S.aiInstalled?.includes(p) === false)
          .map((p) => [p, `The ${p} CLI is not installed`])),
      },
      {
        key: 'general.auto-fetch',
        label: 'Auto fetch',
        description: 'Fetches from the current branch\'s remote when you open a repository or switch branches, '
          + 'and every few minutes after that, so the count of commits to pull stays current. '
          + 'It never pulls. Your branch and files are left as they are.',
        choices: [{ value: 'off', label: 'Off' }, { value: 'on', label: 'On' }],
      },
    ],
  },
  {
    id: 'appearance',
    label: 'Appearance',
    options: [
      {
        key: 'appearance.theme',
        label: 'Theme',
        description: 'Colours for the whole window: the editor, the diff and the terminals. '
          + 'A light theme turns the editor light too.',
        choices: THEMES.map((t) => ({ value: t.id, label: t.label })),
      },
    ],
  },
  // a list the user edits rather than choices, so SettingsDialog.tsx draws this pane itself
  { id: 'commands', label: 'Commands', options: [] },
];
