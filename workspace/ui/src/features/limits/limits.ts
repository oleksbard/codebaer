import { errText, git, type LimitWindow } from '#ipc/git';
import { logInfo } from '#ipc/log';
import { LIMIT_PROVIDERS, type LimitProvider } from '#ipc/settings';
import { notify, S, subscribe } from '#kernel/store';

const EVERY_MS = 5 * 60_000;
const TICK_MS = 60_000;

export const limitsOn = (p: LimitProvider): boolean => S.settings[`limits.${p}`] === 'on';

/** A CLI that was not found is asked again only when it is turned on or from the palette, because each search
 *  for it starts a login shell. */
const missing = new Set<LimitProvider>();
const running = new Map<LimitProvider, Promise<void>>();
const lastError = new Map<LimitProvider, string>();

function read(p: LimitProvider): Promise<void> {
  const busy = running.get(p);
  if (busy) return busy;
  S.limitsBusy = [...S.limitsBusy, p];
  notify();
  const run = (async () => {
    try {
      const windows = await git.usageLimits(p);
      lastError.delete(p);
      if (windows === null) {
        missing.add(p);
        const { [p]: _gone, ...rest } = S.limits;
        S.limits = rest;
      } else {
        missing.delete(p);
        S.limits = { ...S.limits, [p]: { windows, error: null, at: Date.now() } };
      }
    } catch (e) {
      const error = errText(e);
      // a CLI signed in with an API key fails on every read: logged once until the reason changes
      if (lastError.get(p) !== error) logInfo(`${p} limits: ${error}`);
      lastError.set(p, error);
      const prev = S.limits[p];
      S.limits = { ...S.limits, [p]: { windows: prev?.windows ?? null, error, at: prev?.at ?? null } };
    } finally {
      running.delete(p);
      S.limitsBusy = S.limitsBusy.filter((b) => b !== p);
      notify();
    }
  })();
  running.set(p, run);
  return run;
}

/** `all` asks a CLI that was not found as well. */
export function refreshLimits(all = false): Promise<void> {
  const due = LIMIT_PROVIDERS.filter((p) => limitsOn(p) && (all || !missing.has(p)));
  return Promise.all(due.map(read)).then(() => {});
}

export function refreshLimit(p: LimitProvider): Promise<void> {
  return read(p);
}

/** Called once the settings are loaded, so a CLI turned off in the file is never asked. */
export function startLimits(): void {
  let last = 0;
  let on = '';
  const auto = (): void => {
    last = Date.now();
    void refreshLimits();
  };
  // a CLI turned on in Settings is read at once; the first call reads every CLI that is on
  subscribe(() => {
    const now = LIMIT_PROVIDERS.filter(limitsOn);
    if (now.join() === on) return;
    const added = now.filter((p) => !on.split(',').includes(p));
    on = now.join();
    for (const p of added) {
      missing.delete(p);
      void read(p);
    }
  });
  on = LIMIT_PROVIDERS.filter(limitsOn).join();
  auto();
  // a tick rather than one long interval, which a sleeping laptop stretches
  setInterval(() => { if (!document.hidden && Date.now() - last >= EVERY_MS) auto(); }, TICK_MS);
}

/** Compares the percents the pill shows, so two windows that both read 86% tie. A tie goes to the later window. */
const fullest = (windows: readonly LimitWindow[]): LimitWindow | undefined =>
  windows.reduce<LimitWindow | undefined>(
    (top, w) => (top && Math.round(top.percent) > Math.round(w.percent) ? top : w), undefined);

/** The pill's meters, top to bottom: the fullest short window, then the first weekly one. A model's own week
 *  comes after the week of all models, so it stays in the card. */
export function meterWindows(windows: readonly LimitWindow[]): LimitWindow[] {
  return [fullest(windows.filter((w) => !w.weekly)), windows.find((w) => w.weekly)].filter((w) => w !== undefined);
}

/** The pill's number: the fuller of its meters, since a full session blocks as a full week does. On a tie the
 *  week, which blocks for longer. */
export function headline(windows: readonly LimitWindow[]): LimitWindow | undefined {
  return fullest(meterWindows(windows));
}

const DAY_MS = 24 * 3_600_000;
const sameDay = (a: Date, b: Date): boolean => a.toDateString() === b.toDateString();

/** claude writes its reset in English, as `Oct 17 at 11pm (Europe/Berlin)`: the zone goes when it is the
 *  local one, and the date when it is today or tomorrow. */
function claudeReset(text: string, now: Date): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const local = text.replace(` (${zone})`, '');
  const md = (d: Date): string => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const tomorrow = new Date(now.getTime() + DAY_MS);
  for (const [day, word] of [[now, 'today'], [tomorrow, 'tomorrow']] as const) {
    if (local.startsWith(`${md(day)} at `)) return `${word}${local.slice(md(day).length)}`;
  }
  return local;
}

/** When the window starts again, short enough for one line of the tip. */
export function resetText(w: LimitWindow, now = new Date()): string | null {
  if (w.resets !== null) return claudeReset(w.resets, now);
  if (w.resets_at === null) return null;
  const at = new Date(w.resets_at * 1000);
  const time = at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (sameDay(at, now)) return `today at ${time}`;
  if (sameDay(at, new Date(now.getTime() + DAY_MS))) return `tomorrow at ${time}`;
  // no window is longer than a week, so the weekday is enough
  return `${at.toLocaleDateString(undefined, { weekday: 'short' })} at ${time}`;
}

export function agoText(at: number, now = Date.now()): string {
  const min = Math.floor((now - at) / 60_000);
  if (min < 1) return 'just now';
  return min < 60 ? `${min} min ago` : `${Math.floor(min / 60)} h ago`;
}
