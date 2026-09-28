export type Platform = 'macos' | 'linux' | 'windows';

/** From `navigator.platform`, which CodeMirror and xterm read for their own Mod key, so the three cannot disagree. Not
 *  the user agent: tauri.conf.json overrides it on macOS. jsdom's empty string counts as macOS. */
const os = navigator.platform;
const detected: Platform = /Linux/.test(os) ? 'linux' : /Win/.test(os) ? 'windows' : 'macos';

export const platform = (): Platform => detected;
