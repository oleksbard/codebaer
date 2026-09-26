import { DEFAULT_THEME, type Theme } from '#ui/theme';

export type AiProvider = 'off' | 'claude';

/** Keyed by option key, the same flat shape as settings-codebaer.json and the Rust `Settings`. */
export type Settings = { 'general.headless-ai-provider': AiProvider; 'appearance.theme': Theme };
export type SettingKey = keyof Settings;

/** Stored in the settings file too, under `commands.custom`; `repo` is a canonical root, or null for every repo. */
export type CustomCommand = { name: string; command: string; repo: string | null; hide_terminal: boolean };

export const DEFAULTS: Settings = { 'general.headless-ai-provider': 'off', 'appearance.theme': DEFAULT_THEME };
