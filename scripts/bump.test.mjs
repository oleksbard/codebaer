import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { nextVersion, setVersion } from './bump.mjs';

describe('nextVersion', () => {
  it('keeps the current version while nothing is released yet', () => {
    expect(nextVersion('0.1.0', null, 'minor')).toBe('0.1.0');
  });

  it('raises the last release by the level', () => {
    expect(nextVersion('0.1.0', '0.1.0', 'patch')).toBe('0.1.1');
    expect(nextVersion('0.1.3', '0.1.3', 'minor')).toBe('0.2.0');
    expect(nextVersion('1.4.2', '1.4.2', 'major')).toBe('2.0.0');
  });

  it('keeps a pending bump of the same or a higher level', () => {
    expect(nextVersion('0.1.1', '0.1.0', 'patch')).toBe('0.1.1');
    expect(nextVersion('0.2.0', '0.1.0', 'patch')).toBe('0.2.0');
    expect(nextVersion('0.2.0', '0.1.0', 'minor')).toBe('0.2.0');
  });

  it('raises a pending patch to a minor', () => {
    expect(nextVersion('0.1.1', '0.1.0', 'minor')).toBe('0.2.0');
  });

  it('compares numerically, not as text', () => {
    expect(nextVersion('0.10.0', '0.9.0', 'minor')).toBe('0.10.0');
  });

  it('rejects an unknown level and a version that is not plain x.y.z', () => {
    expect(() => nextVersion('0.1.0', '0.1.0', 'huge')).toThrow(/level/);
    expect(() => nextVersion('0.1.0-rc.1', null, 'patch')).toThrow(/0\.1\.0-rc\.1/);
  });
});

describe('setVersion', () => {
  it('changes only the package version in Cargo.toml', () => {
    const toml = '[package]\nname = "codebaer"\nversion = "0.1.0"\n\n[dependencies]\nlog = { version = "0.4" }';
    expect(setVersion(toml, '0.2.0', 'toml')).toBe(toml.replace('version = "0.1.0"', 'version = "0.2.0"'));
  });

  it('finds the version lines in the real manifest and lockfile', () => {
    for (const [file, kind] of [['Cargo.toml', 'toml'], ['Cargo.lock', 'lock']]) {
      const text = readFileSync(`${process.cwd()}/workspace/backend/${file}`, 'utf8');
      const changed = setVersion(text, '99.0.0', kind).split('\n').filter((l, i) => l !== text.split('\n')[i]);
      expect(changed).toEqual(['version = "99.0.0"']);
    }
  });

  it('changes only the codebaer entry in Cargo.lock', () => {
    const entry = (name, v) => `[[package]]\nname = "${name}"\nversion = "${v}"\n`;
    const lock = `${entry('cocoa', '0.1.0')}\n${entry('codebaer', '0.1.0')}`;
    expect(setVersion(lock, '0.2.0', 'lock')).toBe(`${entry('cocoa', '0.1.0')}\n${entry('codebaer', '0.2.0')}`);
  });

  it('throws when the version line is missing', () => {
    expect(() => setVersion('[package]\nname = "codebaer"\n', '0.2.0', 'toml')).toThrow(/Cargo\.toml/);
  });
});
