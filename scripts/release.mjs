import { execFileSync } from 'node:child_process';
import { realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lastRelease } from './bump.mjs';
import { pending, writeNotes } from './changelog.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const quote = (args) => args.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replaceAll("'", "'\\''")}'`)).join(' ');

function gh(args, retry = '') {
  try {
    return execFileSync('gh', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    if (e.code === 'ENOENT') throw new Error('gh CLI not found; install it and run gh auth login');
    const why = String(e.stderr ?? e.message).trim();
    throw new Error(`gh ${quote(args)} failed: ${why}${retry ? `\nretry with: ${retry}` : ''}`);
  }
}

function main() {
  const next = pending();
  if (next.url === null) throw new Error('origin is not a GitHub repository');
  const slug = next.url.replace('https://github.com/', '');
  const tag = `v${next.version}`;

  // Before the notes, so a release run still busy with an older draft stops now, not after Claude answers. By id,
  // because a delete by tag could reach a published release.
  const drafts = gh(['api', '--paginate', `repos/${slug}/releases`, '--jq', '.[] | select(.draft) | .id']);
  for (const id of drafts.split('\n').filter(Boolean)) gh(['api', '-X', 'DELETE', `repos/${slug}/releases/${id}`]);

  const notes = writeNotes(next);
  const file = join(tmpdir(), `codebaer-${tag}.md`);
  writeFileSync(file, notes);
  process.stdout.write(notes);
  if (lastRelease() !== next.released) {
    throw new Error('a release came out while the notes were written; run pnpm bump, push, and pnpm release again');
  }

  const create = ['release', 'create', tag, '--repo', slug, '--draft', '--target', next.sha,
    '--title', `CodeBär ${next.version}`, '--notes-file', file];
  const dispatch = ['workflow', 'run', 'release.yml', '--repo', slug, '--ref', 'main', '-f', `tag=${tag}`];
  const page = gh(create, `gh ${quote(create)} && gh ${quote(dispatch)}`).trim();
  gh(dispatch, `gh ${quote(dispatch)}`);
  console.error(`release: drafted ${tag} at ${page}`);
  console.error(`release: CI publishes it once main's CI passes on ${next.sha.slice(0, 7)}: ${next.url}/actions`);
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (e) {
    console.error(`release: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
