import type { SettingKey, Settings } from '#ipc/settings';
import { THEMES } from '#ui/theme';

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
  // a list the user edits rather than choices, so SettingsDialog.tsx draws this pane itself
  { id: 'commands', label: 'Commands', options: [] },
];
