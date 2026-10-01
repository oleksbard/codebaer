import { describe, expect, it } from 'vitest';
import { moonAt, phasesAt, seasonAt, sunAt } from './sky';

/** The highest the sun gets on a UTC day at longitude 0. */
function noonHeight(y: number, m: number, d: number): number {
  let best = -90;
  for (let min = 0; min < 24 * 60; min += 5) {
    best = Math.max(best, sunAt(new Date(Date.UTC(y, m, d, 0, min)), 0).elevation);
  }
  return best;
}

describe('sky', () => {
  // at 48 degrees north the noon sun stands at 90 - 48 plus or minus the 23.44 degree tilt
  it('puts the noon sun where the seasons do', () => {
    expect(noonHeight(2026, 5, 21)).toBeCloseTo(65.4, 0);
    expect(noonHeight(2026, 11, 21)).toBeCloseTo(18.6, 0);
    expect(noonHeight(2026, 2, 20)).toBeCloseTo(42, 0);
  });

  it('rises in the east, culminates in the south and sets in the west', () => {
    const at = (h: number) => sunAt(new Date(Date.UTC(2026, 2, 20, h)), 0);
    expect(Math.abs(at(6).elevation)).toBeLessThan(3);
    expect(at(6).azimuth).toBeGreaterThan(80);
    expect(at(6).azimuth).toBeLessThan(100);
    expect(at(12).azimuth).toBeGreaterThan(170);
    expect(at(12).azimuth).toBeLessThan(190);
    expect(at(18).azimuth).toBeGreaterThan(260);
  });

  it('gives a longer day in summer than in winter', () => {
    const lit = (m: number) => {
      let n = 0;
      for (let min = 0; min < 24 * 60; min += 10) {
        if (sunAt(new Date(Date.UTC(2026, m, 21, 0, min)), 0).elevation > 0) n++;
      }
      return n / 6;
    };
    expect(lit(5)).toBeGreaterThan(15);
    expect(lit(11)).toBeLessThan(9);
  });

  // the 2024 total eclipse was at a new moon; the full moon came on 23 April
  it('knows the moon phase', () => {
    expect(moonAt(new Date(Date.UTC(2024, 3, 8, 18, 21)))).toBeLessThan(0.02);
    expect(moonAt(new Date(Date.UTC(2024, 3, 23, 23, 49)))).toBeGreaterThan(0.97);
  });

  it('splits the day into parts that add up to one', () => {
    for (let e = -30; e <= 70; e += 0.5) {
      const p = phasesAt(e);
      expect(p.night + p.blue + p.golden + p.day).toBeCloseTo(1, 9);
      for (const v of Object.values(p)) expect(v).toBeGreaterThanOrEqual(-1e-9);
    }
    expect(phasesAt(-20).night).toBe(1);
    expect(phasesAt(-8).blue).toBe(1);
    expect(phasesAt(1).golden).toBe(1);
    expect(phasesAt(30).day).toBe(1);
  });

  it('turns the season tint round the year without a seam', () => {
    const hueOf = (m: number, d: number) => {
      const { a, b } = seasonAt(new Date(Date.UTC(2026, m, d, 12)));
      return ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
    };
    expect(hueOf(2, 21)).toBeCloseTo(145, 0);
    expect(hueOf(8, 23)).toBeCloseTo(55, 0);
    const dec31 = seasonAt(new Date(Date.UTC(2026, 11, 31, 12)));
    const jan1 = seasonAt(new Date(Date.UTC(2027, 0, 1, 12)));
    expect(Math.hypot(dec31.a - jan1.a, dec31.b - jan1.b)).toBeLessThan(0.005);
  });
});
