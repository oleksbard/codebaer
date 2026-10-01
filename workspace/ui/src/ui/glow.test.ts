import { beforeEach, describe, expect, it } from 'vitest';
import { setGlow, skyVars } from './glow';

const css = Object.values(import.meta.glob<string>('./glow.css', {
  query: '?raw', import: 'default', eager: true,
}))[0]!;

const num = (v: string | undefined) => parseFloat(v ?? 'NaN');

describe('shell glow sky', () => {
  it('sets every value glow.css reads, with a unit where it needs one', () => {
    const v = skyVars(new Date(2026, 9, 1, 12));
    for (const name of [...css.matchAll(/var\((--glow-[a-z0-9-]+)\)/g)].map((m) => m[1]!)) {
      if (/^--glow-l\d/.test(name) || ['--glow-base', '--glow-sun', '--glow-disc', '--glow-wash', '--glow-vignette']
        .includes(name)) continue;
      expect(v[name], name).toBeDefined();
    }
    expect(v['--glow-x']).toMatch(/%$/);
    expect(v['--glow-wash-r']).toMatch(/vw$/);
    expect(v['--glow-dx']).toMatch(/px$/);
    expect(v['--glow-tint']).toMatch(/^oklab\(/);
  });

  // a minute repaints the root, so the sky must never move far enough in one to see as a step
  it('changes by a small amount from one minute to the next, all year', () => {
    for (const month of [0, 3, 6, 9]) {
      let prev = skyVars(new Date(2026, month, 1));
      for (let m = 1; m <= 24 * 60; m++) {
        const next = skyVars(new Date(2026, month, 1, 0, m));
        for (const p of ['--glow-x', '--glow-y']) {
          expect(Math.abs(num(next[p]) - num(prev[p])), `${p} ${month}/${m}`).toBeLessThan(3);
        }
        for (const p of ['--glow-size', '--glow-stretch', '--glow-k', '--glow-strength']) {
          expect(Math.abs(num(next[p]) - num(prev[p])), `${p} ${month}/${m}`).toBeLessThan(0.08);
        }
        prev = next;
      }
    }
  });

  it('makes small points at night and stretched lights at the golden hour', () => {
    const night = skyVars(new Date(2026, 5, 21, 1));
    const noon = skyVars(new Date(2026, 5, 21, 13));
    expect(num(night['--glow-size'])).toBeLessThan(0.6);
    expect(num(noon['--glow-size'])).toBeGreaterThan(1.1);
    let widest = 0;
    for (let m = 0; m < 24 * 60; m += 5) {
      widest = Math.max(widest, num(skyVars(new Date(2026, 5, 21, 0, m))['--glow-stretch']));
    }
    expect(widest).toBeGreaterThan(1.7);
  });

  it('lets the moon phase set the night light', () => {
    // a new moon and a full moon in 2026, both at local midnight in June-like dark
    const newMoon = skyVars(new Date(2026, 0, 18, 23, 30));
    const fullMoon = skyVars(new Date(2026, 0, 3, 23, 30));
    expect(num(fullMoon['--glow-k'])).toBeGreaterThan(num(newMoon['--glow-k']) + 0.5);
    expect(num(fullMoon['--glow-wash-r'])).toBeGreaterThan(num(newMoon['--glow-wash-r']));
  });

  // a shorter blend list repeats from its start, which would give a light the grain's overlay blend
  it('lists one blend mode for each background layer', () => {
    const rule = /^\.glow \{([\s\S]*?)\n\}/m.exec(css)![1]!;
    const images = /background-image:([\s\S]*?);/.exec(rule)![1]!;
    const layers = images.match(/url\("|radial-gradient\(/g)!.length;
    const blends = /background-blend-mode:([^;]*);/.exec(rule)![1]!.split(',').length;
    expect(layers).toBe(10);
    expect(blends).toBe(layers);
  });
});

describe('the glow switch', () => {
  beforeEach(() => {
    localStorage.removeItem('codebaer.glow');
    delete document.documentElement.dataset.glow;
    document.documentElement.removeAttribute('style');
  });

  it('writes the root attribute and localStorage, and paints the sky when it turns on', () => {
    setGlow('off');
    expect(document.documentElement.dataset.glow).toBe('off');
    expect(localStorage.getItem('codebaer.glow')).toBe('off');
    expect(document.documentElement.style.getPropertyValue('--glow-x')).toBe('');
    setGlow('on');
    expect(document.documentElement.dataset.glow).toBe('on');
    expect(document.documentElement.style.getPropertyValue('--glow-x')).toMatch(/%$/);
    setGlow('animated');
    expect(localStorage.getItem('codebaer.glow')).toBe('animated');
  });
});
