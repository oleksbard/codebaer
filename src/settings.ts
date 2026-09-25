import { DEFAULT_THEME, THEMES, type Theme } from './ui/theme';

export type AiProvider = 'off' | 'claude';

/** Keyed by option key, the same flat shape as settings-codebaer.json and the Rust `Settings`. */
export type Settings = { 'general.headless-ai-provider': AiProvider; 'appearance.theme': Theme };
export type SettingKey = keyof Settings;

/** Stored in the settings file too, under `commands.custom`; `repo` is a canonical root, or null for every repo. */
export type CustomCommand = { name: string; command: string; repo: string | null };

export const DEFAULTS: Settings = { 'general.headless-ai-provider': 'off', 'appearance.theme': DEFAULT_THEME };

export type Choice<K extends SettingKey> = { value: Settings[K]; label: string };
export type Option = {
  [K in SettingKey]: { key: K; label: string; description: string; choices: Choice<K>[] };
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
        description: 'The command-line AI that writes the commit message from the staged diff. '
          + 'Off turns AI commit messages off. Claude runs the local claude CLI.',
        choices: [{ value: 'off', label: 'Off' }, { value: 'claude', label: 'Claude' }],
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
  // a list the user edits rather than choices, so Settings.tsx draws this pane itself
  { id: 'commands', label: 'Commands', options: [] },
];
