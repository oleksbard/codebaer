import { describe, expect, it } from 'vitest';
import { DUR, EASE, STAGGER } from './motion';

const sheets = import.meta.glob<string>('/src/**/*.css', { query: '?raw', import: 'default', eager: true });

const isTokens = (file: string) => file.endsWith('/tokens.css');

/** Every CSS file under src, comments stripped, keyed by its glob path. */
function files(): [string, string][] {
  return Object.entries(sheets).map(([file, css]) => [file, css.replace(/\/\*[\s\S]*?\*\//g, '')]);
}

describe('motion tokens', () => {
  it('uses cubic-bezier only in tokens.css', () => {
    const hits: string[] = [];
    for (const [file, css] of files()) {
      if (isTokens(file)) continue;
      for (const m of css.matchAll(/cubic-bezier\([^)]*\)/g)) hits.push(`${file}: ${m[0]}`);
    }
    expect(hits).toEqual([]);
  });

  it('uses only token durations in transition and animation declarations', () => {
    const declRe = /\b(transition(?:-[a-z]+)?|animation(?:-[a-z]+)?)\s*:\s*([^;]+);/g;
    const hits: string[] = [];
    for (const [file, css] of files()) {
      if (isTokens(file)) continue;
      for (const decl of css.matchAll(declRe)) {
        for (const time of decl[2]!.matchAll(/\d+(?:\.\d+)?m?s\b/g)) {
          if (time[0] === '0s') continue;
          hits.push(`${file}: ${decl[0].trim()}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });

  it('keeps DUR, EASE and STAGGER equal to tokens.css', () => {
    const tokensCss = files().find(([file]) => isTokens(file))?.[1] ?? '';
    for (const [key, seconds] of Object.entries(DUR)) {
      const m = new RegExp(`--dur-${key}:\\s*([\\d.]+)(ms|s)\\b`).exec(tokensCss);
      expect(m, `--dur-${key} in tokens.css`).not.toBeNull();
      const value = Number(m![1]) * (m![2] === 'ms' ? 0.001 : 1);
      expect(value, `--dur-${key}`).toBeCloseTo(seconds, 5);
    }
    for (const [key, points] of Object.entries(EASE)) {
      const m = new RegExp(`--ease-${key}:\\s*cubic-bezier\\(([^)]+)\\)`).exec(tokensCss);
      expect(m, `--ease-${key} in tokens.css`).not.toBeNull();
      const values = m![1]!.split(',').map(Number);
      expect(values, `--ease-${key}`).toEqual([...points]);
    }
    const m = /--stagger:\s*([\d.]+)(ms|s)\b/.exec(tokensCss);
    expect(m, '--stagger in tokens.css').not.toBeNull();
    expect(Number(m![1]) * (m![2] === 'ms' ? 0.001 : 1), '--stagger').toBeCloseTo(STAGGER, 5);
  });

  it('sets no literal time in a custom property outside tokens.css: it belongs in tokens.css', () => {
    const declRe = /(--[\w-]+)\s*:\s*([^;]+);/g;
    const hits: string[] = [];
    for (const [file, css] of files()) {
      if (isTokens(file)) continue;
      for (const decl of css.matchAll(declRe)) {
        for (const time of decl[2]!.matchAll(/\d+(?:\.\d+)?m?s\b/g)) {
          if (time[0] === '0s') continue;
          hits.push(`${file}: ${decl[0].trim()}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });
});
