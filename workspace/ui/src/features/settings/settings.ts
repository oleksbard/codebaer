import { view } from '#core/session';
import { setEditorDark } from '#editor/editor-theme';
import { retheme } from '#features/terminals';
import { errText, git } from '#ipc/git';
import { DEFAULTS, type CustomCommand, type SettingKey, type Settings } from '#ipc/settings';
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

/** Like `confirmed`, for the command list. */
let confirmedCommands: CustomCommand[] = [];

export function loadSettings(): Promise<void> {
  return inOrder(async () => {
    const [settings, commands] = await Promise.all([git.settings(), git.commands()]);
    S.settings = confirmed = settings;
    S.commands = confirmedCommands = commands;
    showTheme();
    notify();
  });
}

export function loadCommands(): Promise<void> {
  return inOrder(async () => {
    S.commands = confirmedCommands = await git.commands();
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

/** Bumped per opening, so an earlier opening still reading the file cannot reopen it after Escape. */
const settingsEpoch = epoch();

/** Reads the file first, so an edit made to it by hand shows up. */
export async function openSettings(section = 'general'): Promise<void> {
  const live = settingsEpoch.next();
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
