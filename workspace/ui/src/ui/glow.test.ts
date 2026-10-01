import { beforeEach, describe, expect, it } from 'vitest';
import { labOfRgb, type Light, paintsOf, rgbOfLab, setGlow, skyAt } from './glow';

describe('shell glow sky', () => {
  // the sky moves every twenty seconds, so it must never move far enough in a minute to see as a step
  it('changes by a small amount from one minute to the next, all year', () => {
    for (const month of [0, 3, 6, 9]) {
      let prev = skyAt(new Date(2026, month, 1));
      for (let m = 1; m <= 24 * 60; m++) {
        const next = skyAt(new Date(2026, month, 1, 0, m));
        for (const p of ['x', 'y'] as const) {
          expect(Math.abs(next[p] - prev[p]), `${p} ${month}/${m}`).toBeLessThan(3);
        }
        for (const p of ['size', 'stretch', 'washK', 'strength'] as const) {
          expect(Math.abs(next[p] - prev[p]), `${p} ${month}/${m}`).toBeLessThan(0.08);
        }
        prev = next;
      }
    }
  });

  it('makes small points at night and stretched lights at the golden hour', () => {
    expect(skyAt(new Date(2026, 5, 21, 1)).size).toBeLessThan(0.6);
    expect(skyAt(new Date(2026, 5, 21, 13)).size).toBeGreaterThan(1.1);
    let widest = 0;
    for (let m = 0; m < 24 * 60; m += 5) widest = Math.max(widest, skyAt(new Date(2026, 5, 21, 0, m)).stretch);
    expect(widest).toBeGreaterThan(1.7);
  });

  it('lets the moon phase set the night light', () => {
    // a new moon and a full moon in 2026, both just before local midnight
    const newMoon = skyAt(new Date(2026, 0, 18, 23, 30));
    const fullMoon = skyAt(new Date(2026, 0, 3, 23, 30));
    expect(fullMoon.washK).toBeGreaterThan(newMoon.washK + 0.5);
    expect(fullMoon.washR).toBeGreaterThan(newMoon.washR);
  });
});

describe('shell glow paint', () => {
  const sky = skyAt(new Date(2026, 9, 1, 12));
  const scheme = { disc: 0.12, wash: 0.24, vignette: 0.16 };
  const light = (k: number): Light => ({ x: 100, y: 50, r: 200, lab: [0.7, 0.1, 0], k });

  it('paints the wide light first, the lights in reverse, and the dark edges last', () => {
    const paints = paintsOf([light(1), { ...light(1), x: 300 }], sky, scheme, [0.7, 0, 0], 1280, 820);
    expect(paints).toHaveLength(4);
    expect(paints[1]!.x).toBeCloseTo(300 + sky.dx);
    expect(paints[2]!.x).toBeCloseTo(100 + sky.dx);
    expect(paints[3]!.stops.at(-1)).toEqual([1, [0, 0, 0], 0.16]);
  });

  it('keeps a light\'s strength a valid alpha however bright the scene asks for', () => {
    const [, bright] = paintsOf([light(40)], sky, scheme, [0.7, 0, 0], 1280, 820);
    expect(bright!.stops[0]![2]).toBe(1);
    const [, dark] = paintsOf([light(-1)], sky, scheme, [0.7, 0, 0], 1280, 820);
    expect(dark!.stops[0]![2]).toBe(0);
  });

  it('stretches a light sideways by the sky\'s stretch', () => {
    const golden = { ...sky, stretch: 1.8, size: 1, breaths: [0] };
    const [, p] = paintsOf([light(1)], golden, scheme, [0.7, 0, 0], 1280, 820);
    expect(p!.rx).toBeCloseTo(200 * 1.8);
    expect(p!.ry).toBeCloseTo(200 / 1.8);
  });

  it('converts between sRGB and OKLab both ways', () => {
    for (const rgb of [[255, 255, 255], [0, 0, 0], [200, 120, 40], [30, 140, 220]] as const) {
      expect(rgbOfLab(labOfRgb([rgb[0] / 255, rgb[1] / 255, rgb[2] / 255]))).toEqual(rgb);
    }
    expect(labOfRgb([1, 1, 1])[0]).toBeCloseTo(1, 3);
  });
});

describe('the glow switch', () => {
  beforeEach(() => {
    localStorage.removeItem('codebaer.glow');
    delete document.documentElement.dataset.glow;
  });

  it('writes the root attribute and localStorage', () => {
    setGlow('off');
    expect(document.documentElement.dataset.glow).toBe('off');
    expect(localStorage.getItem('codebaer.glow')).toBe('off');
    setGlow('on');
    expect(document.documentElement.dataset.glow).toBe('on');
    setGlow('animated');
    expect(localStorage.getItem('codebaer.glow')).toBe('animated');
  });
});
