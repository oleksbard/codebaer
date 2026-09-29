import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { manifest, parseKey, protoOf, pubkeyOf, signatures, verifySig } from './updates.mjs';

// `tauri signer generate` and `tauri signer sign` output for a throwaway key, whose private half was not kept
const KEY = [
  'dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDhEOTRBM0FGQjAzMEEyMwpSV1FqQ2dQN09rclpDUEViNmxS',
  'SCt4enp1alFjejd2VnpXZXhrYTB0dXlNZkNEa3hOYk1ZRDdzSAo=',
].join('');
const DATA = Buffer.from('hello codebaer\n');
const SIG = [
  'dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVRakNnUDdPa3JaQ0J2UTVKaXhjQmFW',
  'Q1Q0UVJlSnhUcUlBeG5rSW0yOTdkcXpBc25yS01jL2pTd0JRVklVU1hvOEVzVVh2bGlqTVlBK2U3dVpPZmpaUkFtVXUzc3RFL0FN',
  'PQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkwNzE2MTM3CWZpbGU6YXNzZXQuYmluCkl5SWFuVmVKc2V2ZkZFRmUydksz',
  'OEpkcWQ4WnRGeFJwZ09ZNzZ4ZTVQMFppdTBEQ1NuRTlLSUdMZjEvYXRXN1d6VUxzYkJieDcrWnluanluTlpza0FBPT0K',
].join('');

const repoFile = (path) => readFileSync(`${process.cwd()}/workspace/backend/${path}`, 'utf8');

describe('verifySig', () => {
  it('accepts what tauri signed, and returns the trusted comment', () => {
    expect(verifySig(KEY, DATA, SIG)).toBe('timestamp:1790716137\tfile:asset.bin');
  });

  it('rejects a file that changed', () => {
    expect(() => verifySig(KEY, Buffer.from('hello codebaer!\n'), SIG)).toThrow(/does not match the file/);
  });

  it('names both keys when another key signed it', () => {
    expect(() => verifySig(pubkeyOf(repoFile('tauri.conf.json')), DATA, SIG))
      .toThrow('signed with key 8D94A3AFB030A23, but tauri.conf.json has key A495D56554164AD6');
  });

  it('rejects an edited trusted comment', () => {
    const text = Buffer.from(SIG, 'base64').toString('utf8').replace('file:asset.bin', 'file:other.bin');
    expect(() => verifySig(KEY, DATA, Buffer.from(text).toString('base64'))).toThrow(/trusted comment/);
  });

  it('rejects what is not a signature', () => {
    expect(() => verifySig(KEY, DATA, Buffer.from('not\na\nsignature\n').toString('base64'))).toThrow(/not a minisign/);
  });
});

describe('signatures', () => {
  let dir = '';
  const put = (name, content) => writeFileSync(join(dir, name), content);
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'codebaer-updates-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('takes each signed file the updater installs', () => {
    put('codebaer-macos-arm64.tar.gz', DATA);
    put('codebaer-macos-arm64.tar.gz.sig', SIG);
    put('codebaer-linux-amd64.deb', DATA);
    put('codebaer-linux-amd64.deb.sig', `${SIG}\n`);
    put('codebaer-macos-arm64.dmg', 'not installed by the updater');
    expect(signatures(dir, KEY)).toEqual({ 'darwin-aarch64': SIG, 'linux-x86_64-deb': SIG });
  });

  it('refuses a file without a signature', () => {
    put('codebaer-macos-arm64.tar.gz', DATA);
    put('codebaer-macos-arm64.tar.gz.sig', SIG);
    put('codebaer-linux-x86_64.rpm', DATA);
    expect(() => signatures(dir, KEY)).toThrow(/codebaer-linux-x86_64\.rpm has no signature/);
  });

  it('names the file whose signature fails', () => {
    put('codebaer-macos-arm64.tar.gz', 'another build');
    put('codebaer-macos-arm64.tar.gz.sig', SIG);
    expect(() => signatures(dir, KEY)).toThrow(/codebaer-macos-arm64\.tar\.gz: the signature does not match/);
  });

  it('refuses a release without the macOS app', () => {
    put('codebaer-linux-amd64.deb', DATA);
    put('codebaer-linux-amd64.deb.sig', SIG);
    expect(() => signatures(dir, KEY)).toThrow(/codebaer-macos-arm64\.tar\.gz is missing/);
  });
});

describe('manifest', () => {
  it('points each platform at the file in the release of its own tag', () => {
    const sigs = { 'darwin-aarch64': 'mac', 'linux-x86_64-rpm': 'rpm' };
    const date = '2026-09-29T12:00:00Z';
    const url = (name) => `https://github.com/o/r/releases/download/v0.6.0/${name}`;
    expect(manifest({ repo: 'o/r', tag: 'v0.6.0', notes: '- New.', date, proto: 3, sigs })).toEqual({
      version: '0.6.0', notes: '- New.', pub_date: date, proto: 3,
      platforms: {
        'darwin-aarch64': { url: url('codebaer-macos-arm64.tar.gz'), signature: 'mac' },
        'linux-x86_64-rpm': { url: url('codebaer-linux-x86_64.rpm'), signature: 'rpm' },
      },
    });
  });
});

describe('the repo files a release reads', () => {
  it('has a minisign public key in tauri.conf.json', () => {
    expect(parseKey(pubkeyOf(repoFile('tauri.conf.json'))).id).toHaveLength(8);
  });

  it('has the terminal protocol in proto.rs', () => {
    expect(protoOf(repoFile('src/pty/proto.rs'))).toBeGreaterThan(0);
  });

  it('throws when either is missing', () => {
    expect(() => pubkeyOf('{"plugins":{}}')).toThrow(/plugins\.updater\.pubkey/);
    expect(() => protoOf('pub const OTHER: u32 = 3;')).toThrow(/PROTO/);
  });
});
