import { DEFAULTS, type CustomCommand, type HiddenScripts, type Settings } from '#ipc/settings';

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
  }
}

export const settingsState = () => ({
  settings: { ...DEFAULTS }, settingsOpen: false, settingsSection: 'general', commands: [], hiddenScripts: {},
});
