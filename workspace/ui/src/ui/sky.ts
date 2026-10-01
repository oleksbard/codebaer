/** The sky over the shell glow: where the sun is, how full the moon is, which part of the day it is and the
 *  season, all from the date. Pure, so a test can set any moment. */

const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const smooth = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/** The place the sun is seen from. The app asks for no location: the longitude comes from the standard time
 *  zone offset (15 degrees an hour), and the latitude is a mid-northern guess. Sun times can be about an hour
 *  out, which a glow does not show. */
export const LATITUDE = 48;

export function longitudeOf(date: Date): number {
  const y = date.getFullYear();
  // daylight saving moves the clock and not the sun, so the standard offset is the larger of the two
  const offset = Math.max(new Date(y, 0, 1).getTimezoneOffset(), new Date(y, 6, 1).getTimezoneOffset());
  return -offset / 4;
}

function dayOfYear(date: Date): number {
  return Math.floor((date.getTime() - Date.UTC(date.getUTCFullYear(), 0, 0)) / 864e5);
}

/** The NOAA general solar position equations: elevation above the horizon and azimuth clockwise from north,
 *  in degrees. Good to about a degree, far more than a glow needs. */
export function sunAt(date: Date, lon: number, lat = LATITUDE): { elevation: number; azimuth: number } {
  const hour = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
  const g = ((2 * Math.PI) / 365) * (dayOfYear(date) - 1 + (hour - 12) / 24);
  const eqtime = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g)
    - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g)
    + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const ha = rad((hour * 60 + eqtime + 4 * lon) / 4 - 180);
  const phi = rad(lat);
  const cosZen = Math.sin(phi) * Math.sin(decl) + Math.cos(phi) * Math.cos(decl) * Math.cos(ha);
  const elevation = 90 - deg(Math.acos(clamp(cosZen, -1, 1)));
  const azimuth = (deg(Math.atan2(Math.sin(ha), Math.cos(ha) * Math.sin(phi) - Math.tan(decl) * Math.cos(phi)))
    + 540) % 360;
  return { elevation, azimuth };
}

const NEW_MOON = Date.UTC(2000, 0, 6, 18, 14);
const SYNODIC_DAYS = 29.530588853;

/** The lit fraction of the moon, 0 at new moon and 1 at full, from the mean synodic month. */
export function moonAt(date: Date): number {
  const age = (((date.getTime() - NEW_MOON) / 864e5 / SYNODIC_DAYS) % 1 + 1) % 1;
  return (1 - Math.cos(2 * Math.PI * age)) / 2;
}

/** How much of each part of the day it is, by the sun's elevation; the four add up to 1. The bounds follow
 *  the photographers' golden hour (about -4 to 6 degrees) and blue hour (about -6 to -4), widened so that one
 *  part fades into the next. */
export type Phases = { night: number; blue: number; golden: number; day: number };

export function phasesAt(elevation: number): Phases {
  const dusk = smooth(-14, -10, elevation);
  const twilight = smooth(-6, -3, elevation);
  const high = smooth(5, 10, elevation);
  return { night: 1 - dusk, blue: dusk - twilight, golden: twilight - high, day: high };
}

/** How far the wide light has gone from the sun's place to the moon's, 0 by day and 1 at night. Wider than the
 *  night's own band, so the light takes about an hour to cross the window. */
export const moonShare = (elevation: number): number => 1 - smooth(-18, -4, elevation);

/** OKLCH hue and chroma of each season's tint, at the northern equinoxes and solstices, by day of the year. */
const SEASONS = [
  { day: 80, hue: 145, c: 0.1 },
  { day: 172, hue: 100, c: 0.09 },
  { day: 266, hue: 55, c: 0.12 },
  { day: 355, hue: 250, c: 0.08 },
];

/** The season's tint as OKLab a and b, eased from one anchor to the next round the year. */
export function seasonAt(date: Date): { a: number; b: number } {
  const d = dayOfYear(date);
  const i = SEASONS.findIndex((s) => s.day > d);
  const p = SEASONS[(i === -1 ? SEASONS.length : i) - 1] ?? SEASONS[SEASONS.length - 1]!;
  const q = SEASONS[i === -1 ? 0 : i]!;
  const span = (q.day - p.day + 365) % 365;
  const t = (1 - Math.cos(Math.PI * (((d - p.day + 365) % 365) / span))) / 2;
  const ab = (s: typeof p) => [s.c * Math.cos(rad(s.hue)), s.c * Math.sin(rad(s.hue))] as const;
  const [pa, pb] = ab(p);
  const [qa, qb] = ab(q);
  return { a: pa + (qa - pa) * t, b: pb + (qb - pb) * t };
}
