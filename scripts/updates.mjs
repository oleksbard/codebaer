import { createHash, createPublicKey, verify } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageVersion } from './bump.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Each file the updater installs, by the target tauri-plugin-updater looks it up under: `{os}-{arch}`, or with the
 *  bundle type appended, which it tries first. */
export const TARGETS = {
  'darwin-aarch64': 'codebaer-macos-arm64.tar.gz',
  'linux-x86_64-deb': 'codebaer-linux-amd64.deb',
  'linux-x86_64-rpm': 'codebaer-linux-x86_64.rpm',
};

// as the comment in a `.pub` file prints it: the little-endian number the 8 bytes hold, in hex without padding
const keyId = (bytes) => Buffer.from(bytes).reverse().toString('hex').toUpperCase().replace(/^0+(?=.)/, '');

/** The key in tauri's form: base64 of a whole minisign `.pub` file, whose second line holds `Ed`, the key id and
 *  the Ed25519 key. */
export function parseKey(pubkey) {
  const raw = Buffer.from(Buffer.from(pubkey, 'base64').toString('utf8').split('\n')[1] ?? '', 'base64');
  if (raw.length !== 42 || raw.subarray(0, 2).toString() !== 'Ed') throw new Error('not a minisign public key');
  const x = raw.subarray(10).toString('base64url');
  return { id: raw.subarray(2, 10), key: createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x }, format: 'jwk' }) };
}

/** Checks a signature as `tauri signer sign` writes it, the way the updater does: the one over the file's BLAKE2b-512
 *  hash, then the one over the trusted comment. Returns the trusted comment. */
export function verifySig(pubkey, data, sig) {
  const { id, key } = parseKey(pubkey);
  const [, line = '', comment = '', global = ''] = Buffer.from(sig.trim(), 'base64').toString('utf8').split('\n');
  const raw = Buffer.from(line, 'base64');
  const prefix = 'trusted comment: ';
  if (raw.length !== 74 || raw.subarray(0, 2).toString() !== 'ED' || !comment.startsWith(prefix)) {
    throw new Error('not a minisign signature of a hashed file');
  }
  if (!raw.subarray(2, 10).equals(id)) {
    throw new Error(`signed with key ${keyId(raw.subarray(2, 10))}, but tauri.conf.json has key ${keyId(id)}`);
  }
  if (!verify(null, createHash('blake2b512').update(data).digest(), key, raw.subarray(10))) {
    throw new Error('the signature does not match the file');
  }
  const trusted = comment.slice(prefix.length);
  const globalSig = Buffer.from(global, 'base64');
  const covered = Buffer.concat([raw.subarray(10), Buffer.from(trusted)]);
  if (globalSig.length !== 64 || !verify(null, covered, key, globalSig)) {
    throw new Error('the trusted comment does not match its signature');
  }
  return trusted;
}

export const pubkeyOf = (conf) => {
  const key = JSON.parse(conf).plugins?.updater?.pubkey;
  if (typeof key !== 'string') throw new Error('tauri.conf.json has no plugins.updater.pubkey');
  return key;
};

export const protoOf = (rs) => {
  const m = /^pub const PROTO: u32 = (\d+);$/m.exec(rs);
  if (!m) throw new Error('no PROTO constant in proto.rs');
  return Number(m[1]);
};

/** Checks `file` against the `.sig` next to it, and returns the signature. */
export function checkFile(file, pubkey) {
  if (!existsSync(`${file}.sig`)) throw new Error(`${file} has no signature`);
  const sig = readFileSync(`${file}.sig`, 'utf8').trim();
  try {
    verifySig(pubkey, readFileSync(file), sig);
  } catch (e) {
    throw new Error(`${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
  return sig;
}

/** The signature of each file in `dir` the updater installs, checked. A release always has the macOS app. */
export function signatures(dir, pubkey) {
  const out = {};
  for (const [target, name] of Object.entries(TARGETS)) {
    const file = join(dir, name);
    if (existsSync(file)) out[target] = checkFile(file, pubkey);
  }
  if (out['darwin-aarch64'] === undefined) throw new Error(`${TARGETS['darwin-aarch64']} is missing`);
  return out;
}

/** The static manifest the updater reads from the latest release. Its URLs name the release's own tag, so a client
 *  that read it just before a newer release came out still downloads the file its signature is for. `proto` is the
 *  terminal host's protocol: when it changes, the running terminals cannot survive the update. */
export function manifest({ repo, tag, notes, date, proto, sigs }) {
  const platforms = Object.fromEntries(Object.entries(sigs).map(([target, signature]) => [
    target, { url: `https://github.com/${repo}/releases/download/${tag}/${TARGETS[target]}`, signature },
  ]));
  return { version: tag.slice(1), notes, pub_date: date, proto, platforms };
}

const read = (path) => readFileSync(join(ROOT, path), 'utf8');

function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const pubkey = pubkeyOf(read('workspace/backend/tauri.conf.json'));
  if (cmd === 'verify' && args.length > 0) {
    for (const file of args) {
      checkFile(file, pubkey);
      console.log(`updates: ${file} is signed with the updater's key`);
    }
    return;
  }
  if (cmd !== 'manifest' || args.length !== 4) {
    throw new Error('usage: node scripts/updates.mjs verify <file>... | manifest <dir> <owner/repo> <tag> <notes>');
  }
  const [dir, repo, tag, notes] = args;
  // a manifest that announces a version other than the app's own would offer the same update again after every
  // install
  const version = packageVersion(read('workspace/backend/Cargo.toml'));
  if (tag !== `v${version}`) throw new Error(`the tag is ${tag}, but the app in this commit is ${version}`);
  const out = manifest({
    repo, tag,
    notes: readFileSync(notes, 'utf8').trim(),
    date: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    proto: protoOf(read('workspace/backend/src/pty/proto.rs')),
    sigs: signatures(dir, pubkey),
  });
  writeFileSync(join(dir, 'latest.json'), `${JSON.stringify(out, null, 2)}\n`);
  console.log(`updates: wrote latest.json for ${tag}: ${Object.keys(out.platforms).join(', ')}`);
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (e) {
    console.error(`updates: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
