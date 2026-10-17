import { DEFAULTS, type AiProvider, type CustomCommand, type HiddenScripts, type Settings } from '#ipc/settings';

declare module '#kernel/store' {
  interface State {
    /** The defaults until start() reads the file. */
    settings: Settings;
    settingsOpen: boolean;
    settingsSection: string;
    /** Every saved command, other repos' included; read with the settings. */
    commands: CustomCommand[];
    /** Every repo's, read and saved with the commands. */
    hiddenScripts: HiddenScripts;
    /** The providers whose CLI is installed, checked on each opening of Settings; null before the first answer. */
    aiInstalled: AiProvider[] | null;
    /** Whether this build can send usage data at all, once the backend has said. */
    usageDataAvailable: boolean;
  }
}

export const settingsState = () => ({
  settings: { ...DEFAULTS }, settingsOpen: false, settingsSection: 'general', commands: [], hiddenScripts: {},
  aiInstalled: null, usageDataAvailable: false,
});
