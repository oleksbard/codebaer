import { view } from '#core/session';
import { setEditorDark } from '#editor/editor-theme';
import { retheme } from '#features/terminals';
import { errText, git } from '#ipc/git';
import { logError } from '#ipc/log';
import { DEFAULTS, type CustomCommand, type HiddenScripts, type SettingKey, type Settings } from '#ipc/settings';
import { toast } from '#kernel/dialogs';
import { epoch } from '#kernel/epoch';
import { idle } from '#kernel/registry';
import { notify, S } from '#kernel/store';
import { getTheme, isDark, setTheme } from '#ui/theme';

/** One at a time: two saves in flight could land in either order, and a read between a save and
 *  its result would show the old value. */
let settingsQueue: Promise<unknown> = Promise.resolve();
function inOrder<T>(fn: () => Promise<T>): Promise<T> {
  const run = settingsQueue.then(fn);
  settingsQueue = run.catch(() => {});
  return run;
}

/** What the file holds, as far as this window knows. A failed save goes back to it, not to the value
 *  before its own click: an earlier click may have failed too. */
let confirmed: Settings = { ...DEFAULTS };

/** The page follows S.settings, so a failed save that puts the old value back also puts back its theme.
 *  Tokens repaint on their own; the editor's base styles and xterm's palette are read once and need telling. */
function showTheme(): void {
  const t = S.settings['appearance.theme'];
  if (t === getTheme()) return;
  setTheme(t);
  setEditorDark(view, isDark(t));
  retheme();
}

/** Like `confirmed`, for the command list and the hidden scripts. */
let confirmedCommands: CustomCommand[] = [];
let confirmedHidden: HiddenScripts = {};

export function loadSettings(): Promise<void> {
  return inOrder(async () => {
    const [settings, commands, hidden] = await Promise.all([git.settings(), git.commands(), git.hiddenScripts()]);
    S.settings = confirmed = settings;
    S.commands = confirmedCommands = commands;
    S.hiddenScripts = confirmedHidden = hidden;
    showTheme();
    notify();
  });
}

export function loadCommands(): Promise<void> {
  return inOrder(async () => {
    const [commands, hidden] = await Promise.all([git.commands(), git.hiddenScripts()]);
    S.commands = confirmedCommands = commands;
    S.hiddenScripts = confirmedHidden = hidden;
    notify();
  });
}

/** The whole list at once, other repos' included, since that is the shape the file keeps. */
export function saveCommands(list: CustomCommand[]): Promise<void> {
  S.commands = list;
  notify();
  return inOrder(async () => {
    const sent = S.commands;
    if (sent === confirmedCommands) return;
    try {
      await git.saveCommands(sent);
      confirmedCommands = sent;
    } catch (e) {
      S.commands = confirmedCommands;
      toast(`Commands not saved: ${errText(e)}`, 'err');
    }
    notify();
  });
}

/** Leaves one of this repo's package.json scripts out of the command menu, or puts it back. */
export function hideScript(name: string, hidden: boolean): Promise<void> {
  const root = S.root;
  if (root === null) return Promise.resolve();
  const rest = (S.hiddenScripts[root] ?? []).filter((n) => n !== name);
  const names = hidden ? [...rest, name] : rest;
  const others = Object.entries(S.hiddenScripts).filter(([r]) => r !== root);
  S.hiddenScripts = Object.fromEntries(names.length ? [...others, [root, names]] : others);
  notify();
  return inOrder(async () => {
    const sent = S.hiddenScripts;
    if (sent === confirmedHidden) return;
    try {
      await git.saveHiddenScripts(sent);
      confirmedHidden = sent;
    } catch (e) {
      S.hiddenScripts = confirmedHidden;
      toast(`Scripts not saved: ${errText(e)}`, 'err');
    }
    notify();
  });
}

const installedEpoch = epoch();

/** Asked on every opening, so a CLI installed while the app runs shows up. */
async function checkInstalled(): Promise<void> {
  const live = installedEpoch.next();
  try {
    const list = await git.installedAiProviders();
    if (!live()) return;
    S.aiInstalled = list;
    notify();
  } catch (e) {
    logError(e, 'installed AI providers');
  }
}

/** Bumped per opening, so an earlier opening still reading the file cannot reopen it after Escape. */
const settingsEpoch = epoch();

/** Reads the file first, so an edit made to it by hand shows up. */
export async function openSettings(section = 'general'): Promise<void> {
  const live = settingsEpoch.next();
  // not awaited: until it answers, every provider stays enabled
  void checkInstalled();
  try {
    await loadSettings();
  } catch (e) {
    if (live()) toast(`Settings could not be read: ${errText(e)}`, 'err');
    return;
  }
  // something else took the screen while the file was read, or this was opened again
  if (!live() || !idle()) return;
  S.settingsOpen = true;
  S.settingsSection = section;
  notify();
}

export function closeSettings(): void {
  settingsEpoch.bump();
  S.settingsOpen = false;
  notify();
}

const same = (a: Settings, b: Settings) => (Object.keys(a) as SettingKey[]).every((k) => a[k] === b[k]);

export function setSetting<K extends SettingKey>(key: K, value: Settings[K]): Promise<void> {
  S.settings = { ...S.settings, [key]: value };
  showTheme();
  notify();
  return inOrder(async () => {
    const sent = S.settings;
    // nothing to write, e.g. a change queued behind a failed save, which undid it
    if (same(sent, confirmed)) return;
    try {
      await git.saveSettings(sent);
      confirmed = sent;
    } catch (e) {
      // a failed write leaves the file as it was
      S.settings = confirmed;
      showTheme();
      toast(`Settings not saved: ${errText(e)}`, 'err');
    }
    notify();
  });
}
