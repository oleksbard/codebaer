import { DEFAULT_THEME, type Theme } from '#ui/theme';

export const AI_PROVIDERS = ['claude', 'codex', 'opencode'] as const;
export type AiProvider = 'off' | (typeof AI_PROVIDERS)[number];

/** Keyed by option key, the same flat shape as settings-codebaer.json and the Rust `Settings`. */
export type Settings = {
  'general.headless-ai-provider': AiProvider; 'general.auto-fetch': 'on' | 'off'; 'appearance.theme': Theme;
};
export type SettingKey = keyof Settings;

/** Stored in the settings file too, under `commands.custom`; `repo` is a canonical root, or null for every repo.
 *  `icon` is an id such as `lucide:hammer` that the user picked, or null to show the AI's pick. */
export type CustomCommand = {
  name: string; command: string; repo: string | null; hide_terminal: boolean; icon: string | null;
};

/** Stored in the settings file under `commands.hidden-scripts`: the package.json scripts the command menu leaves
 *  out, by name, keyed by canonical repository root like `CustomCommand.repo`. A name is kept after its script
 *  goes, so a branch that drops the script for a while does not bring it back. */
export type HiddenScripts = Record<string, string[]>;

export const DEFAULTS: Settings = {
  'general.headless-ai-provider': 'off', 'general.auto-fetch': 'on', 'appearance.theme': DEFAULT_THEME,
};
