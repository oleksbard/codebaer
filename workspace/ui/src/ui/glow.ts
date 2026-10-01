import { cubicBezier } from 'motion/react';
import { DUR, EASE, heavyMotion, STAGGER } from './motion';
import { longitudeOf, moonAt, moonShare, phasesAt, seasonAt, sunAt, type Phases } from './sky';

/** A place in the window: px from its left or top edge, or a percentage of its width or height. */
export type GlowPos = number | `${number}%`;

/** One of the glow's seven lights in a scene. r is the radius in px before the sky scales it, color is any CSS
 *  colour (a theme token), and k scales its strength. */
export type GlowLight = { x: GlowPos; y: GlowPos; r: number; color: string; k: number };

export const LIGHTS = 7;

/** An OKLab colour: lightness, a and b. */
type Lab = readonly [number, number, number];

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const mixLab = (p: Lab, q: Lab, t: number): Lab => [lerp(p[0], q[0], t), lerp(p[1], q[1], t), lerp(p[2], q[2], t)];
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

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

/** The time of day as the glow shows it. x and y place the wide light in percent of the window, washR is its
 *  radius as a share of the window's width, and dx and dy are the slow drift of every light in px. */
export type Sky = {
  x: number; y: number; washR: number; wash: Lab; washK: number;
  size: number; stretch: number; strength: number; tint: Lab; tintShare: number;
  dx: number; dy: number; breaths: number[];
};

export function skyAt(now: Date): Sky {
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

  const minutes = now.getTime() / 60000;
  // standard time, not the clock: a daylight saving night would step the drift by an hour's worth
  const turn = (2 * Math.PI * (minutes / 60 + lon / 15)) / 24;
  return {
    x: sunX + (moonX - sunX) * m,
    y: height(sun.elevation) + (height(-sun.elevation) - height(sun.elevation)) * m,
    washR: 0.57 * (1 - w.night + w.night * (0.55 + 0.45 * moon)),
    wash: [0.75, blend((x) => ab(x.wash[0], x.wash[1])[0]!), blend((x) => ab(x.wash[0], x.wash[1])[1]!)],
    washK: blend((x) => x.washK) - w.night * (1 - (0.2 + 0.8 * moon)),
    size: blend((x) => x.size),
    stretch: blend((x) => x.stretch),
    strength: blend((x) => x.strength),
    tint: [blend((x) => x.tint[0]), tintA + (season.a - tintA) * SEASON_SHARE,
      tintB + (season.b - tintB) * SEASON_SHARE],
    tintShare: blend((x) => x.tintShare) / 100,
    dx: -48 * Math.sin(turn),
    dy: 18 * Math.sin(2 * turn),
    breaths: BREATHS.map((period, i) => Math.sin((2 * Math.PI * minutes) / period + 1.7 * i)),
  };
}

// ---- the paint ----

/** A scene's light at one moment, in px and OKLab. */
export type Light = { x: number; y: number; r: number; lab: Lab; k: number };

/** The strength of each light, of the wide light, and of the dark edges. A light theme's base shows a light
 *  more than a dark one's, and its edges need less. */
export type Scheme = { disc: number; wash: number; vignette: number };
const SCHEMES = {
  dark: { disc: 0.12, wash: 0.24, vignette: 0.16 },
  light: { disc: 0.14, wash: 0.22, vignette: 0.04 },
} satisfies Record<string, Scheme>;

/** One radial gradient in window px: an ellipse with radii rx and ry, and its stops as a share of rx. */
export type Paint = { x: number; y: number; rx: number; ry: number; stops: [number, Lab, number][] };

/** Every gradient of the glow, bottom first: the wide light, the seven lights, then the dark edges. */
export function paintsOf(lights: readonly Light[], sky: Sky, scheme: Scheme, accent: Lab, w: number,
  h: number): Paint[] {
  const sun = mixLab(sky.wash, accent, 0.25);
  const wash = clamp01(scheme.wash * sky.washK);
  const washR = sky.washR * w;
  const paints: Paint[] = [{
    x: (sky.x / 100) * w, y: (sky.y / 100) * h, rx: washR, ry: washR, stops: [[0, sun, wash], [1, sun, 0]],
  }];
  for (let i = lights.length - 1; i >= 0; i--) {
    const l = lights[i]!;
    const b = sky.breaths[i] ?? 0;
    const size = l.r * sky.size * (1 + b * 0.12);
    const alpha = clamp01(scheme.disc * sky.strength * l.k * (1 + b * 0.2));
    const glow = mixLab(l.lab, sky.tint, sky.tintShare);
    paints.push({
      x: l.x + sky.dx, y: l.y + sky.dy, rx: size * sky.stretch, ry: size / sky.stretch,
      stops: [[0, glow, alpha], [0.4, glow, alpha * 0.32], [1, glow, 0]],
    });
  }
  const far = 0.66 * Math.max(w, h);
  const black: Lab = [0, 0, 0];
  paints.push({
    x: w / 2, y: h / 2, rx: far, ry: far,
    stops: [[Math.min(1, (0.35 * Math.min(w, h)) / far), black, 0], [1, black, scheme.vignette]],
  });
  return paints;
}

// ---- colours ----

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGamma = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

/** sRGB channels from 0 to 1 to OKLab, by Björn Ottosson's matrices. */
export function labOfRgb(rgb: readonly [number, number, number]): Lab {
  const [r, g, b] = rgb.map(toLinear) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** OKLab to sRGB channels from 0 to 255, clipped to the gamut. */
export function rgbOfLab([L, a, b]: Lab): [number, number, number] {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((c) => Math.round(clamp01(toGamma(c)) * 255)) as [number, number, number];
}

const colors = new Map<string, Lab>();
let probe: HTMLElement | null = null;
let swatch: CanvasRenderingContext2D | null | undefined;

/** A CSS colour as OKLab. The style resolves the theme's var() chain and the canvas any colour syntax the
 *  engine knows; both answers are kept until the theme changes. */
function labOf(color: string): Lab {
  const known = colors.get(color);
  if (known) return known;
  swatch ??= document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  if (!swatch) return [0.7, 0, 0];
  if (!probe?.isConnected) {
    probe = document.createElement('i');
    probe.style.display = 'none';
    document.body.append(probe);
  }
  probe.style.color = color;
  swatch.clearRect(0, 0, 1, 1);
  swatch.fillStyle = getComputedStyle(probe).color;
  swatch.fillRect(0, 0, 1, 1);
  const [r = 0, g = 0, b = 0] = swatch.getImageData(0, 0, 1, 1).data;
  const lab = labOfRgb([r / 255, g / 255, b / 255]);
  colors.set(color, lab);
  return lab;
}

// ---- scenes ----

/** A light's flight from where it was to its new place. `mid` is the focus pull's waypoint, at 45% of the way. */
type Flight = { from: Light; mid: Light | null; start: number; delay: number };

let scene: readonly GlowLight[] = [];
let flights: (Flight | null)[] = [];
const ease = cubicBezier(...EASE.out);

const resolve = (p: GlowPos, size: number) => (typeof p === 'number' ? p : (parseFloat(p) / 100) * size);
const place = (l: GlowLight, w: number, h: number): Light =>
  ({ x: resolve(l.x, w), y: resolve(l.y, h), r: l.r, lab: labOf(l.color), k: l.k });
const between = (p: Light, q: Light, t: number): Light => ({
  x: lerp(p.x, q.x, t), y: lerp(p.y, q.y, t), r: lerp(p.r, q.r, t), lab: mixLab(p.lab, q.lab, t), k: lerp(p.k, q.k, t),
});

/** Where light i is at time t. A flight that is done is dropped here. */
function lightAt(i: number, t: number, w: number, h: number): Light {
  const to = place(scene[i]!, w, h);
  const f = flights[i];
  if (!f) return to;
  const run = (t - f.start - f.delay) / (DUR[5] * 1000);
  if (run >= 1) {
    flights[i] = null;
    return to;
  }
  if (run <= 0) return f.from;
  const p = ease(run);
  if (!f.mid) return between(f.from, to, p);
  return p < 0.45 ? between(f.from, f.mid, p / 0.45) : between(f.mid, to, (p - 0.45) / 0.55);
}

/** How a scene arrives. `pull` is a focus pull: each light shrinks and brightens as it leaves, swings along a
 *  curve, and blooms to its new size. `ease` glides the lights that changed. `cut` shows the scene at once. */
export type Arrival = 'pull' | 'ease' | 'cut';

export function showGlowScene(lights: readonly GlowLight[], arrival: Arrival): void {
  const still = document.documentElement.dataset.glow !== 'animated' || !heavyMotion()
    || globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const how = still ? 'cut' : arrival;
  const t = performance.now();
  const w = globalThis.innerWidth;
  const h = globalThis.innerHeight;
  const next = lights.map((l, i): Flight | null => {
    // a glide leaves a light whose target did not change alone, its flight in progress included
    if (how === 'ease' && JSON.stringify(scene[i]) === JSON.stringify(l)) return flights[i] ?? null;
    // a light that never had a place (the first scene) has nowhere to fly from
    if (how === 'cut' || !scene[i]) return null;
    // a flight in progress is where the next one starts from
    const from = lightAt(i, t, w, h);
    if (how === 'ease') return { from, mid: null, start: t, delay: 0 };
    const to = place(l, w, h);
    // every other light swings the other way, so the flight looks like a swirl, not a slide
    const mid = { ...between(from, to, 0.45), x: (from.x + to.x) / 2 + (i % 2 ? 60 : -60), y: (from.y + to.y) / 2,
      r: Math.min(from.r, to.r) * 0.55, k: Math.max(from.k, to.k) * 1.6 };
    return { from, mid, start: t, delay: i * STAGGER * 1000 };
  });
  scene = lights;
  flights = next;
  draw();
}

// ---- the surfaces ----

/** Bitmap px per CSS px. The lights are soft enough that the browser's smooth upscale of a quarter size bitmap
 *  shows them as sharp as full size gradients would. Where nothing composites the page (WebKitGTK without a GPU),
 *  each frame of an animation over a surface paints its background again: nine gradients the size of the window
 *  halved the frame rate, and so did a canvas element; one image in the background costs nothing to see. */
const SCALE = 0.25;

/** Each surface's bitmap, the image it last asked to show, and the numbers of the last image asked for and shown. */
type Surface = { canvas: HTMLCanvasElement; url: string; asked: number; shown: number };
const surfaces = new Map<HTMLElement, Surface>();
let sky = skyAt(new Date());
let frame = 0;

/** Draws on the next frame, so every change in one frame shares one bitmap: encoding one cost WebKitGTK about
 *  10ms. A flight asks for the frame after. The image shows only once decoded, so a first frame waits anyway. */
function draw(): void {
  if (frame || !surfaces.size) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    paint();
    if (flights.some(Boolean)) draw();
  });
}

function fill(ctx: CanvasRenderingContext2D, p: Paint, w: number, h: number): void {
  const sy = p.ry / p.rx;
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.scale(1, sy);
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, p.rx);
  for (const [at, lab, alpha] of p.stops) g.addColorStop(at, `rgba(${rgbOfLab(lab).join(', ')}, ${alpha})`);
  ctx.fillStyle = g;
  ctx.fillRect(-p.x, -p.y / sy, w, h / sy);
  ctx.restore();
}

/** The new image replaces the old one once it is decoded, so the surface never paints a frame without one. Any
 *  image newer than the one shown replaces it: in a flight, a decode slower than a frame would otherwise always
 *  be too late, and the lights would jump to the end. */
function show(el: HTMLElement, surface: Surface, url: string): void {
  if (url === surface.url) return;
  surface.url = url;
  const n = ++surface.asked;
  const img = new Image();
  img.src = url;
  img.decode().then(() => {
    if (n <= surface.shown) return;
    surface.shown = n;
    el.style.setProperty('--glow-image', `url("${url}")`);
  }, () => {
    if (surface.url === url) surface.url = '';
  });
}

function paint(): void {
  if (!on() || !surfaces.size) return;
  const w = globalThis.innerWidth;
  const h = globalThis.innerHeight;
  const t = performance.now();
  const lights = scene.map((_, i) => lightAt(i, t, w, h));
  const scheme = SCHEMES[document.documentElement.dataset.scheme === 'light' ? 'light' : 'dark'];
  const paints = paintsOf(lights, sky, scheme, labOf('var(--accent)'), w, h);
  for (const [el, surface] of surfaces) {
    const { canvas } = surface;
    const box = el.getBoundingClientRect();
    const ctx = box.width && box.height ? canvas.getContext('2d') : null;
    if (!ctx) continue;
    const cw = Math.ceil(box.width * SCALE);
    const ch = Math.ceil(box.height * SCALE);
    // setting the size clears the bitmap even when it is the same
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
    } else {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, cw, ch);
    }
    // window px onto this surface's bitmap: each surface shows its own part of one glow
    const kx = cw / box.width;
    const ky = ch / box.height;
    ctx.setTransform(kx, 0, 0, ky, -box.left * kx, -box.top * ky);
    for (const p of paints) fill(ctx, p, w, h);
    show(el, surface, canvas.toDataURL());
  }
}

/** The ref of each surface: drawn from its first frame, and again whenever its box changes size. */
export function glowLayer(el: HTMLElement | null): (() => void) | undefined {
  if (!el) return undefined;
  surfaces.set(el, { canvas: document.createElement('canvas'), url: '', asked: 0, shown: 0 });
  const resized = new ResizeObserver(() => draw());
  resized.observe(el);
  draw();
  return () => {
    resized.disconnect();
    surfaces.delete(el);
  };
}

// ---- the switch ----

/** Off, on (shown as Enabled: the sky without the flight between scenes) or animated. */
export type GlowMode = 'off' | 'on' | 'animated';
const MODES: readonly string[] = ['off', 'on', 'animated'] satisfies GlowMode[];

const KEY = 'codebaer.glow';
const on = (): boolean => document.documentElement.dataset.glow !== 'off';

/** The settings file owns the choice; the copy in localStorage only lets the first paint use it. */
export function setGlow(mode: GlowMode): void {
  const root = document.documentElement;
  if (root.dataset.glow === mode) return;
  const was = on();
  root.dataset.glow = mode;
  localStorage.setItem(KEY, mode);
  if (mode !== 'animated' && flights.some(Boolean)) {
    flights = [];
    draw();
  }
  if (!was && on()) {
    sky = skyAt(new Date());
    draw();
  }
}

/** Twenty seconds move the sky by too little to see as a step, even while the wide light crosses the window at
 *  dusk. */
export function initGlow(): void {
  const root = document.documentElement;
  // as an inherited property, each new image would restyle everything inside the surface
  try {
    (globalThis.CSS as { registerProperty?: (def: object) => void } | undefined)
      ?.registerProperty?.({ name: '--glow-image', syntax: '*', inherits: false });
  } catch { /* a hot reload registers it again, which throws */ }
  const stored = localStorage.getItem(KEY);
  root.dataset.glow = stored !== null && MODES.includes(stored) ? stored : 'animated';
  const repaint = () => {
    if (!on() || document.hidden) return;
    sky = skyAt(new Date());
    draw();
  };
  setInterval(repaint, 20_000);
  document.addEventListener('visibilitychange', repaint);
  new MutationObserver(() => {
    colors.clear();
    draw();
  }).observe(root, { attributeFilter: ['data-theme', 'data-scheme'] });
}
