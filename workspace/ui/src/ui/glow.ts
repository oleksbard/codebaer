import { DUR, EASE, heavyMotion, STAGGER } from './motion';
import { longitudeOf, moonAt, moonShare, phasesAt, seasonAt, sunAt, type Phases } from './sky';

/** One of the glow's seven lights in a scene. x and y are CSS lengths in the window (the background is fixed,
 *  so a percentage is of the window), r is the radius in px before the sky scales it, color is any CSS colour
 *  (a theme token), and k scales its strength. */
export type GlowLight = { x: string; y: string; r: number; color: string; k: number };

export const LIGHTS = 7;

const prop = (i: number, p: 'x' | 'y' | 'r' | 'c' | 'k') => `--glow-l${i + 1}-${p}`;

/** Registered, so that an animation moves them through their values instead of flipping at the end. They do
 *  not inherit: each surface holds its own, so a frame of the flight restyles the two surfaces and nothing
 *  inside them. */
function register(): void {
  const css = globalThis.CSS as { registerProperty?: (def: object) => void } | undefined;
  if (!css?.registerProperty) return;
  const syntax = { x: '<length-percentage>', y: '<length-percentage>', r: '<length>', c: '<color>', k: '<number>' };
  const initial = { x: '0px', y: '0px', r: '0px', c: 'transparent', k: '0' };
  for (let i = 0; i < LIGHTS; i++) {
    for (const p of ['x', 'y', 'r', 'c', 'k'] as const) {
      // a second registration throws, which a hot reload of this module does
      try {
        css.registerProperty({ name: prop(i, p), syntax: syntax[p], inherits: false, initialValue: initial[p] });
      } catch { /* already registered */ }
    }
  }
}

// ---- the sky ----

type Mood = { size: number; stretch: number; tint: [number, number, number]; tintShare: number; strength: number;
  wash: [number, number]; washK: number };

/** How each part of the day treats the lights: their size and shape, the tint mixed into them (OKLCH L, C, H)
 *  and how much, their strength, and the wide light's colour (C, H) and strength. */
const MOODS: Record<keyof Phases, Mood> = {
  // large, soft and pale under a high neutral sky
  day: { size: 1.15, stretch: 1, tint: [0.95, 0.02, 90], tintShare: 10, strength: 1, wash: [0.06, 235], washK: 0.9 },
  // low warm light; the lights stretch sideways as an anamorphic lens draws a flare
  golden: { size: 1, stretch: 1.8, tint: [0.82, 0.13, 70], tintShare: 35, strength: 1.1, wash: [0.14, 62],
    washK: 1.15 },
  // the sun just under the horizon: a deep blue wash and the strongest colour of the day
  blue: { size: 0.95, stretch: 1, tint: [0.62, 0.12, 262], tintShare: 28, strength: 1.3, wash: [0.12, 265],
    washK: 1 },
  // small sharp points with little colour, like far city lights; the moon sets washK
  night: { size: 0.5, stretch: 1, tint: [0.8, 0.03, 250], tintShare: 50, strength: 1.2, wash: [0.03, 250],
    washK: 1 },
};

/** Each light breathes on its own slow cycle, in minutes. No period divides another, so the pattern does not
 *  come back within a day. */
const BREATHS = [23, 31, 41, 53, 67, 79, 89];

const SEASON_SHARE = 0.3;

export type SkyVars = Record<string, string>;

/** Every root variable glow.css reads for the time of day. */
export function skyVars(now: Date): SkyVars {
  const lon = longitudeOf(now);
  const sun = sunAt(now, lon);
  const moon = moonAt(now);
  const w = phasesAt(sun.elevation);
  const blend = (f: (m: Mood) => number) =>
    (Object.keys(w) as (keyof Phases)[]).reduce((sum, p) => sum + w[p] * f(MOODS[p]), 0);
  const ab = (c: number, h: number) => [c * Math.cos((h * Math.PI) / 180), c * Math.sin((h * Math.PI) / 180)];
  const season = seasonAt(now);
  const tintA = blend((m) => ab(m.tint[1], m.tint[2])[0]!);
  const tintB = blend((m) => ab(m.tint[1], m.tint[2])[1]!);

  // a light's side of the window is its compass side seen facing south: east on the left, west on the right
  const across = (azimuth: number) => Math.min(98, Math.max(2, ((azimuth - 60) / 240) * 100));
  const height = (elevation: number) => Math.min(40, Math.max(0, 30 - elevation * 0.6));
  // the moon is taken as opposite the sun, which is where a full moon is; each one's azimuth passes north, where
  // it jumps from one edge to the other, only while its own share is nothing
  const sunX = across(sun.azimuth);
  const moonX = across((sun.azimuth + 180) % 360);
  const m = moonShare(sun.elevation);
  const x = sunX + (moonX - sunX) * m;
  const y = height(sun.elevation) + (height(-sun.elevation) - height(sun.elevation)) * m;
  const washR = 57 * (1 - w.night + w.night * (0.55 + 0.45 * moon));

  const minutes = now.getTime() / 60000;
  // standard time, not the clock: a daylight saving night would step the drift by an hour's worth
  const turn = (2 * Math.PI * (minutes / 60 + lon / 15)) / 24;
  const vars: SkyVars = {
    '--glow-x': `${x.toFixed(2)}%`,
    '--glow-y': `${y.toFixed(2)}%`,
    '--glow-wash-r': `${washR.toFixed(1)}vw`,
    '--glow-a': blend((m) => ab(m.wash[0], m.wash[1])[0]!).toFixed(4),
    '--glow-b': blend((m) => ab(m.wash[0], m.wash[1])[1]!).toFixed(4),
    '--glow-k': (blend((m) => m.washK) - w.night * (1 - (0.2 + 0.8 * moon))).toFixed(3),
    '--glow-size': blend((m) => m.size).toFixed(3),
    '--glow-stretch': blend((m) => m.stretch).toFixed(3),
    '--glow-strength': blend((m) => m.strength).toFixed(3),
    '--glow-tint': `oklab(${blend((m) => m.tint[0]).toFixed(3)} `
      + `${(tintA + (season.a - tintA) * SEASON_SHARE).toFixed(4)} `
      + `${(tintB + (season.b - tintB) * SEASON_SHARE).toFixed(4)})`,
    '--glow-tint-p': `${blend((m) => m.tintShare).toFixed(1)}%`,
    '--glow-dx': `${(-48 * Math.sin(turn)).toFixed(1)}px`,
    '--glow-dy': `${(18 * Math.sin(2 * turn)).toFixed(1)}px`,
  };
  BREATHS.forEach((period, i) => {
    vars[`--glow-b${i + 1}`] = Math.sin((2 * Math.PI * minutes) / period + 1.7 * i).toFixed(3);
  });
  return vars;
}

function paint(root: HTMLElement, now: Date): void {
  for (const [name, value] of Object.entries(skyVars(now))) root.style.setProperty(name, value);
}

// ---- scenes ----

const surfaces = () => [...document.querySelectorAll<HTMLElement>('.glow')];

/** What each light was last sent to, so a glide can leave a light that did not change where it is. */
let shown: readonly GlowLight[] = [];

type Values = Record<'x' | 'y' | 'r' | 'c' | 'k', string>;

const valuesOf = (l: GlowLight): Values => ({ x: l.x, y: l.y, r: `${l.r}px`, c: l.color, k: String(l.k) });

function keyframe(i: number, v: Partial<Values>, offset?: number): Keyframe {
  const frame: Keyframe = offset === undefined ? {} : { offset };
  for (const [p, value] of Object.entries(v)) frame[prop(i, p as keyof Values)] = value;
  return frame;
}

/** How a scene arrives. `pull` is a focus pull: each light shrinks and brightens as it leaves, swings along a
 *  curve, and blooms to its new size. `ease` glides the lights that changed. `cut` shows the scene at once. */
export type Arrival = 'pull' | 'ease' | 'cut';

export function showGlowScene(lights: readonly GlowLight[], arrival: Arrival): void {
  const still = document.documentElement.dataset.glow !== 'animated' || !heavyMotion()
    || globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const how = still ? 'cut' : arrival;
  // a glide leaves a light whose target did not change alone, its flight in progress included
  const moving = lights.map((l, i) => how !== 'ease' || JSON.stringify(shown[i]) !== JSON.stringify(l));
  for (const el of surfaces()) {
    // a flight in progress is where the next one starts from
    const style = how === 'cut' ? null : getComputedStyle(el);
    const from = lights.map((_, i): Values => ({
      x: style?.getPropertyValue(prop(i, 'x')) ?? '', y: style?.getPropertyValue(prop(i, 'y')) ?? '',
      r: style?.getPropertyValue(prop(i, 'r')) ?? '', c: style?.getPropertyValue(prop(i, 'c')) ?? '',
      k: style?.getPropertyValue(prop(i, 'k')) ?? '',
    }));
    for (const a of el.getAnimations()) {
      const i = /^glow-(\d+)$/.exec(a.id)?.[1];
      if (i !== undefined && moving[Number(i)]) a.cancel();
    }
    lights.forEach((l, i) => {
      if (!moving[i]) return;
      for (const [p, value] of Object.entries(valuesOf(l))) el.style.setProperty(prop(i, p as keyof Values), value);
    });
    if (how === 'cut') continue;
    lights.forEach((l, i) => {
      const a = from[i]!;
      const b = valuesOf(l);
      // a light that never had a place (the first scene) has nowhere to fly from
      if (!moving[i] || !a.r || parseFloat(a.r) === 0) return;
      const frames = [keyframe(i, a)];
      if (how === 'pull') {
        const r = Math.min(parseFloat(a.r), l.r) * 0.55;
        const k = Math.max(parseFloat(a.k) || 0, l.k) * 1.6;
        // every other light swings the other way, so the flight looks like a swirl, not a slide
        const swing = i % 2 ? 60 : -60;
        frames.push(keyframe(i, {
          x: `calc((${a.x} + ${b.x}) / 2 + ${swing}px)`, y: `calc((${a.y} + ${b.y}) / 2)`, r: `${r.toFixed(1)}px`,
          k: k.toFixed(3),
        }, 0.45));
      }
      frames.push(keyframe(i, b));
      const anim = el.animate(frames, {
        duration: DUR[5] * 1000, delay: how === 'pull' ? i * STAGGER * 1000 : 0,
        easing: `cubic-bezier(${EASE.out.join(',')})`, fill: 'backwards',
      });
      anim.id = `glow-${i}`;
    });
  }
  shown = lights;
}

// ---- the switch ----

/** Off, on (shown as Enabled: the sky without the flight between scenes) or animated. */
export type GlowMode = 'off' | 'on' | 'animated';
const MODES: readonly string[] = ['off', 'on', 'animated'] satisfies GlowMode[];

const KEY = 'codebaer.glow';
const on = (): boolean => document.documentElement.dataset.glow !== 'off';
// every style change on the root restyles the whole page, so a hidden window waits until it is shown
const due = (): boolean => on() && !document.hidden;

/** The settings file owns the choice; the copy in localStorage only lets the first paint use it. */
export function setGlow(mode: GlowMode): void {
  const root = document.documentElement;
  if (root.dataset.glow === mode) return;
  if (mode !== 'off' && !on()) paint(root, new Date());
  root.dataset.glow = mode;
  localStorage.setItem(KEY, mode);
}

/** Twenty seconds move the sky by too little to see as a step, even while the wide light crosses the window at
 *  dusk. */
export function initGlow(): void {
  const root = document.documentElement;
  register();
  const stored = localStorage.getItem(KEY);
  root.dataset.glow = stored !== null && MODES.includes(stored) ? stored : 'animated';
  paint(root, new Date());
  setInterval(() => { if (due()) paint(root, new Date()); }, 20_000);
  document.addEventListener('visibilitychange', () => { if (due()) paint(root, new Date()); });
}
