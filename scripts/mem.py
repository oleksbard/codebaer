#!/usr/bin/env python3
"""Measures how much memory CodeBär and other git apps use on the same test repos.

  pnpm mem fixtures [--out DIR] [--only s,m,l] [--force]
  pnpm mem run APP --repo DIR [--profile clean|real] [--label NAME] [--manual STEP] [--churn SECS]
  pnpm mem report [DIR]

APP is codebaer, vscode, cursor, zed or smerge. Memory is the physical footprint, the number Activity
Monitor shows, summed over every process macOS holds the app responsible for. That takes in the
WebKit and Electron helpers, whose parent is launchd, and CodeBär's detached terminal host. Shells
are reported but left out of the total, since a shell costs the same in every app. Results and the
clean profiles go next to the repos, in results/ and homes/.
"""
from __future__ import annotations

import argparse
import csv
import ctypes
import json
import os
import plistlib
import random
import re
import shutil
import signal
import statistics
import subprocess
import sys
import textwrap
import threading
import time
import unicodedata
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
COMPARISON = ROOT.parent / 'comparison'
MB = 1024 * 1024
NUM = re.compile(r'(?<![\w.])\d+(?![\w.])')

# ---------------------------------------------------------------------------------------------------- fixtures

NOUNS = ('order invoice customer cart payment shipment refund coupon product price stock warehouse account session '
         'token report ticket review comment branch commit release build task job queue event metric alert user team '
         'project setting theme label').split()
SUFFIXES = ('', 'service', 'store', 'view', 'rules', 'format', 'api', 'queue', 'cache', 'events', 'model', 'utils')
VERBS = 'load save find build merge check format parse apply sync update remove count group sort split'.split()
FIELDS = 'amount total count limit weight score retries priority offset size'.split()
STATES = 'pending stale active failed ready draft'.split()
MESSAGES = ('Fix rounding in totals', 'Rename the store helpers', 'Cache lookups by id', 'Tighten the retry limits',
            'Document the sync flow', 'Split the order views', 'Drop the stale draft state',
            'Clamp scores before saving')
OPS = ('number', 'string', 'comment', 'delete', 'function')
MARKER = 'codebaer-mem-fixture'
# fixed commit dates keep the commit hashes the same on every build
EPOCH = 1767607200
EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'


@dataclass(frozen=True)
class Spec:
    packages: int
    ts: int
    crates: int
    rs: int
    docs: int
    lines: tuple[int, int]
    commits: int
    changed: int
    hunks: int
    untracked: int
    deleted: int
    ops: tuple[str, ...] = OPS
    minimal: bool = False


SPECS = {
    's': Spec(1, 1, 0, 0, 1, (24, 24), commits=1, changed=1, hunks=1, untracked=0, deleted=0, ops=('number',),
              minimal=True),
    'm': Spec(4, 200, 2, 60, 30, (30, 110), commits=5, changed=10, hunks=4, untracked=1, deleted=1),
    'l': Spec(20, 2000, 10, 600, 300, (30, 140), commits=20, changed=30, hunks=5, untracked=3, deleted=2),
}

BASE_TS = '''export const cache = new Map<string, unknown>();

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export async function fetchJson<T>(url: string, options: { timeout: number }): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error('request failed: ' + response.status);
    }
    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}'''.splitlines()

BASE_RS = '''pub fn clamp(value: i64, min: i64, max: i64) -> i64 {
    value.max(min).min(max)
}'''.splitlines()


def pascal(name: str) -> str:
    return ''.join(part.capitalize() for part in re.split(r'[-_]', name) if part)


def unique(used: set[str], name: str) -> str:
    base, n = name, 2
    while name in used:
        name, n = f'{base}{n}', n + 1
    used.add(name)
    return name


def spread(total: int, parts: int) -> list[int]:
    return [total // parts + (1 if i < total % parts else 0) for i in range(parts)]


def sentence(rng: random.Random) -> str:
    a, b = rng.sample(NOUNS, 2)
    return rng.choice((
        f'The {a} {rng.choice(SUFFIXES[1:])} keeps {rng.choice(STATES)} {b}s until the next sync.',
        f'Every {a} has a {rng.choice(FIELDS)} that is checked before it is saved.',
        f'When a {a} is {rng.choice(STATES)}, the {b} view shows it at the top of the list.',
        f'A {a} can belong to one {b} at most, and moving it keeps its history.',
        f'Retries back off for {rng.randint(2, 30)} seconds before a {a} is marked as failed.',
    ))


def ts_item(rng: random.Random, kind: str, t: str, f1: str, f2: str, state: str, imports: list[tuple[str, str]],
            used: set[str]) -> list[str]:
    n, n2, verb = rng.randint(2, 500), rng.randint(500, 5000), rng.choice(VERBS)
    if kind == 'const':
        return [f'export const {unique(used, f"{t.upper()}_{rng.choice(FIELDS).upper()}_LIMIT")} = {n};']
    if kind == 'filter':
        return [f'/** Returns the items whose {f1} is above the limit, with the {f1} clamped. */',
                f'export function {unique(used, f"{verb}{t}s")}(items: {t}[], limit = {n}): {t}[] {{',
                f'  const result: {t}[] = [];',
                '  for (const item of items) {',
                f'    if (item.{f1} > limit) {{',
                f'      result.push({{ ...item, {f1}: clamp(item.{f1}, 0, {n2}) }});',
                '    }',
                '  }',
                '  return result;',
                '}']
    if kind == 'load':
        route = re.sub(r'(?<!^)(?=[A-Z])', '-', t).lower()
        return [f'/** Loads one {t} by id, from the cache when it is there. */',
                f'export async function {unique(used, f"{verb}{t}")}(id: string): Promise<{t} | undefined> {{',
                f'  const cached = cache.get(id) as {t} | undefined;',
                '  if (cached) {',
                '    return cached;',
                '  }',
                f"  const value = await fetchJson<{t}>('/api/{route}/' + id, {{ timeout: {n} }});",
                f"  if (value.status === '{state}') {{",
                '    cache.set(id, value);',
                '  }',
                '  return value;',
                '}']
    if kind == 'total':
        return [f'/** Sums the {f2} of every item, weighted by {n}. */',
                f'export function {unique(used, f"{verb}{t}Total")}(items: {t}[]): number {{',
                f'  return items.reduce((sum, item) => sum + item.{f2} * {n}, 0);',
                '}']
    if kind == 'class':
        return [f'export class {unique(used, t + pascal(rng.choice(SUFFIXES[1:])))} {{',
                f'  private readonly items = new Map<string, {t}>();',
                f'  add(item: {t}): void {{',
                '    this.items.set(item.id, item);',
                '  }',
                '  get size(): number {',
                '    return this.items.size;',
                '  }',
                f'  {verb}(limit = {n}): {t}[] {{',
                f'    return [...this.items.values()].filter((item) => item.{f2} < limit);',
                '  }',
                '}']
    _, other = rng.choice(imports)
    return [f'/** Pairs an item with the {other} it belongs to. */',
            f'export function {unique(used, f"link{t}To{other}")}(item: {t}, other: {other}): string {{',
            f"  return item.id + ':' + other.id + ':{rng.choice(STATES)}';",
            '}']


def ts_module(rng: random.Random, name: str, imports: list[tuple[str, str]], target: int,
              standalone: bool = False) -> list[str]:
    t = pascal(name)
    f1, f2 = rng.sample(FIELDS, 2)
    a, b = rng.sample(STATES, 2)
    head = [] if standalone else ["import { cache, clamp, fetchJson } from '../base';"]
    head += [f"import type {{ {typ} }} from '{path}';" for path, typ in imports]
    lines = head + ([''] if head else []) + [
        f'export interface {t} {{', '  id: string;', f'  {f1}: number;', f'  {f2}: number;',
        f"  status: '{a}' | '{b}';", '  updatedAt: Date;', '}', '']
    used = {t} | {typ for _, typ in imports}
    kinds = ['const', 'total', 'class'] + ([] if standalone else ['filter', 'load']) + (['link'] if imports else [])
    while len(lines) < target:
        lines += ts_item(rng, rng.choice(kinds), t, f1, f2, a, imports, used) + ['']
    return lines[:-1]


def rs_module(rng: random.Random, target: int) -> list[str]:
    lines, tests, used = ['use crate::base::clamp;', ''], [], set()
    while len(lines) < target or not tests:
        t = unique(used, pascal(rng.choice(NOUNS)) + pascal(rng.choice(SUFFIXES[1:])))
        snake = re.sub(r'(?<!^)(?=[A-Z])', '_', t).lower()
        f1, f2 = rng.sample(FIELDS, 2)
        n, n2, verb = rng.randint(2, 50), rng.randint(100, 5000), rng.choice(VERBS)
        ids = unique(used, f'{verb}_{snake}_ids')
        lines += [
            f'/// A {snake.replace("_", " ")} as this crate stores it.',
            '#[derive(Debug, Clone, PartialEq)]',
            f'pub struct {t} {{', '    pub id: u64,', f'    pub {f1}: i64,', f'    pub {f2}: i64,',
            '    pub label: String,', '}',
            '',
            f'impl {t} {{',
            '    pub fn new(id: u64) -> Self {',
            f'        Self {{ id, {f1}: {n}, {f2}: {n2}, label: String::from("{rng.choice(STATES)}") }}',
            '    }',
            '',
            f'    /// Adds up the {f1} over the first `limit` steps.',
            f'    pub fn {verb}_{f1}(&self, limit: i64) -> i64 {{',
            '        let mut total = 0;',
            '        for step in 0..limit {',
            f'            if step % {n} == 0 {{',
            f'                total += clamp(self.{f1} * step, 0, {n2});',
            '            }',
            '        }',
            '        total',
            '    }',
            '}',
            '',
            f'/// Returns the ids of the items whose {f2} is above {n}.',
            f'pub fn {ids}(items: &[{t}]) -> Vec<u64> {{',
            f'    items.iter().filter(|item| item.{f2} > {n}).map(|item| item.id).collect()',
            '}',
            '']
        tests += ['', '    #[test]', f'    fn {ids}_keeps_large_items() {{',
                  f'        let mut item = {t}::new(1);', f'        item.{f2} = {n} + 1;',
                  f'        assert_eq!({ids}(&[item]), vec![1]);', '    }']
    return lines + ['#[cfg(test)]', 'mod tests {', '    use super::*;'] + tests + ['}']


def md_doc(rng: random.Random, title: str, target: int) -> list[str]:
    lines = [f'# {title}', '']
    while len(lines) < target:
        kind = rng.choice(('para', 'para', 'list', 'code', 'heading'))
        if kind == 'para':
            lines += textwrap.wrap(' '.join(sentence(rng) for _ in range(rng.randint(2, 5))), 100)
        elif kind == 'list':
            lines += [f'- {sentence(rng)}' for _ in range(rng.randint(2, 5))]
        elif kind == 'code':
            lines += ['```sh', f'pnpm {rng.choice(VERBS)} --{rng.choice(FIELDS)} {rng.randint(1, 99)}', '```']
        else:
            lines += [f'## {rng.choice(VERBS).capitalize()} the {rng.choice(NOUNS)}']
        lines.append('')
    return lines[:-1]


def new_function(rng: random.Random, lang: str) -> list[str]:
    verb, noun, fld, n = rng.choice(VERBS), rng.choice(NOUNS), rng.choice(FIELDS), rng.randint(2, 900)
    if lang == 'ts':
        return [f'/** {sentence(rng)} */',
                f'export function {verb}{pascal(noun)}{pascal(fld)}(values: number[]): number {{',
                f'  return values.filter((value) => value > {n}).length;',
                '}']
    if lang == 'rs':
        return [f'/// {sentence(rng)}',
                f'pub fn {verb}_{noun}_{fld}(values: &[i64]) -> i64 {{',
                f'    values.iter().copied().filter(|v| *v > {n}).sum()',
                '}']
    return [f'## {verb.capitalize()} the {noun}', '', sentence(rng)]


def edit(rng: random.Random, lines: list[str], p: int, lang: str, ops: tuple[str, ...]) -> None:
    """Changes one spot, touching nothing more than 3 lines away from line p."""
    window = range(max(0, p - 3), min(len(lines), p + 4))
    op = rng.choice(ops)
    if op == 'number':
        for i in window:
            if NUM.search(lines[i]) and not lines[i].startswith(('import', 'use ', '#')):
                lines[i] = NUM.sub(lambda m: str(int(m.group()) + rng.randint(1, 9)), lines[i], count=1)
                return
    elif op == 'string':
        pattern = re.compile(r'([\'"])([a-z]+)\1')
        for i in window:
            # a status literal has to stay inside its union type, or the TS no longer checks
            if pattern.search(lines[i]) and not lines[i].startswith(('import', 'use ')) and 'status' not in lines[i]:
                lines[i] = pattern.sub(
                    lambda m: m.group(1) + rng.choice([s for s in STATES if s != m.group(2)]) + m.group(1),
                    lines[i], count=1)
                return
    elif op == 'delete':
        for i in window:
            if lines[i].strip().startswith(('/**', '///', '- ')):
                del lines[i]
                return
    elif op == 'function':
        for i in window:
            if lines[i] == '':
                lines[i + 1:i + 1] = new_function(rng, lang) + ['']
                return
    at = min(p, len(lines) - 1)
    indent = re.match(r'\s*', lines[at]).group() if lang != 'md' else ''
    lines.insert(p, indent + ('' if lang == 'md' else '// ') + sentence(rng))


def lang_of(path: str) -> str:
    return Path(path).suffix.lstrip('.')


def json_lines(value: object) -> list[str]:
    return json.dumps(value, indent=2).splitlines()


def layout(rng: random.Random, name: str, spec: Spec) -> tuple[dict[str, list[str]], list[str]]:
    """The first commit's files, and the ones later edits may touch."""
    lo, hi = spec.lines
    if spec.minimal:
        files = {'README.md': md_doc(rng, 'Fixture', lo),
                 'src/index.ts': ts_module(rng, 'order', [], lo, standalone=True)}
        return files, sorted(files)
    files = {
        '.gitignore': ['node_modules/', 'target/', 'dist/'],
        'README.md': md_doc(rng, f'Fixture {name}', 40),
        'package.json': json_lines({'name': f'fixture-{name}', 'private': True, 'workspaces': ['packages/*']}),
        'tsconfig.json': json_lines({
            'compilerOptions': {'target': 'ES2022', 'module': 'ESNext', 'moduleResolution': 'Bundler',
                                'lib': ['ES2022', 'DOM'], 'strict': True, 'noEmit': True},
            'include': ['packages/*/src']}),
    }
    editable: list[str] = []
    used_pkgs: set[str] = set()
    for count in spread(spec.ts, spec.packages):
        pkg = unique(used_pkgs, f'{rng.choice(NOUNS)}-{rng.choice(("app", "core", "web", "api", "kit", "sdk"))}')
        files[f'packages/{pkg}/package.json'] = json_lines(
            {'name': f'@fixture/{pkg}', 'version': '0.1.0', 'private': True, 'type': 'module'})
        files[f'packages/{pkg}/src/base.ts'] = list(BASE_TS)
        areas = rng.sample(NOUNS, min(len(NOUNS), max(1, count // 8)))
        mods: list[tuple[str, str]] = []
        used: set[str] = set()
        for _ in range(count):
            area = rng.choice(areas)
            suffix = rng.choice(SUFFIXES)
            mod = unique(used, rng.choice(NOUNS) + (f'-{suffix}' if suffix else ''))
            imports = [(f'./{m}' if a == area else f'../{a}/{m}', pascal(m))
                       for a, m in rng.sample(mods, min(len(mods), rng.randint(0, 2)))]
            path = f'packages/{pkg}/src/{area}/{mod}.ts'
            files[path] = ts_module(rng, mod, imports, rng.randint(lo, hi))
            editable.append(path)
            mods.append((area, mod))
    if spec.crates:
        files['Cargo.toml'] = ['[workspace]', 'members = ["crates/*"]', 'resolver = "2"']
    used_crates: set[str] = set()
    for count in spread(spec.rs, spec.crates) if spec.crates else []:
        crate = unique(used_crates, f'{rng.choice(NOUNS)}-{rng.choice(("core", "store", "sync", "cli"))}')
        files[f'crates/{crate}/Cargo.toml'] = ['[package]', f'name = "{crate}"', 'version = "0.1.0"',
                                               'edition = "2021"']
        files[f'crates/{crate}/src/base.rs'] = list(BASE_RS)
        used = set()
        mods = [unique(used, f'{rng.choice(NOUNS)}_{rng.choice(SUFFIXES[1:])}') for _ in range(count)]
        files[f'crates/{crate}/src/lib.rs'] = ['pub mod base;'] + [f'pub mod {m};' for m in mods]
        for m in mods:
            path = f'crates/{crate}/src/{m}.rs'
            files[path] = rs_module(rng, rng.randint(lo, hi))
            editable.append(path)
    used = set()
    for _ in range(spec.docs):
        topic = unique(used, f'{rng.choice(NOUNS)}-{rng.choice(("guide", "notes", "design", "faq", "setup"))}')
        path = f'docs/{topic}.md'
        files[path] = md_doc(rng, topic.replace('-', ' ').capitalize(), rng.randint(lo, hi))
        editable.append(path)
    return files, editable


def git(cwd: Path, *args: str, commit: int | None = None) -> str:
    env = {**os.environ, 'GIT_CONFIG_GLOBAL': os.devnull, 'GIT_CONFIG_NOSYSTEM': '1',
           'GIT_AUTHOR_NAME': 'Fixture', 'GIT_AUTHOR_EMAIL': 'fixture@example.invalid',
           'GIT_COMMITTER_NAME': 'Fixture', 'GIT_COMMITTER_EMAIL': 'fixture@example.invalid'}
    if commit is not None:
        env['GIT_AUTHOR_DATE'] = env['GIT_COMMITTER_DATE'] = f'{EPOCH + commit * 86400} +0000'
    return subprocess.run(['git', *args], cwd=cwd, env=env, check=True, capture_output=True, text=True).stdout


def write(dest: Path, path: str, lines: list[str]) -> None:
    target = dest / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text('\n'.join(lines) + '\n')


def build(out: Path, name: str, spec: Spec, force: bool) -> None:
    dest = out / name
    if dest.exists():
        if not force:
            print(f'{name}: {dest} exists, pass --force to build it again')
            return
        if not (dest / '.git' / MARKER).exists():
            sys.exit(f'{dest} was not built by this script, not deleting it')
        shutil.rmtree(dest)
    dest.mkdir(parents=True)
    rng = random.Random(f'codebaer-fixture-{name}')
    files, editable = layout(rng, name, spec)
    git(dest, 'init', '-q', '-b', 'main')
    (dest / '.git' / MARKER).write_text(f'{name}\n')
    for path, lines in files.items():
        write(dest, path, lines)
    git(dest, 'add', '-A')
    git(dest, 'commit', '-q', '-m', 'Initial import', commit=0)
    for k in range(1, spec.commits):
        for path in rng.sample(editable, max(3, len(editable) // 40)):
            for _ in range(rng.randint(1, 2)):
                edit(rng, files[path], rng.randrange(len(files[path])), lang_of(path), spec.ops)
            write(dest, path, files[path])
        git(dest, 'add', '-A')
        git(dest, 'commit', '-q', '-m', rng.choice(MESSAGES), commit=k)

    # 16 lines a hunk keeps at least 7 unchanged lines between two edits, so git never joins them
    eligible = [p for p in editable if len(files[p]) >= spec.hunks * 16]
    rng.shuffle(eligible)
    changed = eligible[:spec.changed]
    for path in changed:
        lines = files[path]
        seg = len(lines) // spec.hunks
        for h in reversed(range(spec.hunks)):
            edit(rng, lines, h * seg + rng.randint(7, seg - 8), lang_of(path), spec.ops)
        write(dest, path, lines)
    # only docs, since deleting a module breaks every module that imports it
    for path in rng.sample([p for p in editable if p.endswith('.md') and p not in changed], spec.deleted):
        (dest / path).unlink()
    ts = [p for p in editable if p.endswith('.ts')]
    for _ in range(spec.untracked):
        folder = Path(rng.choice(ts)).parent
        mod = unique({Path(p).stem for p in ts if Path(p).parent == folder}, f'{rng.choice(NOUNS)}-draft')
        write(dest, f'{folder}/{mod}.ts', ts_module(rng, mod, [], rng.randint(*spec.lines)))
    describe(dest, name)


def describe(dest: Path, name: str) -> None:
    def count(*args: str) -> int:
        return len(git(dest, *args).splitlines())

    lines = re.search(r'(\d+) insertion', git(dest, 'diff', '--shortstat', EMPTY_TREE, 'HEAD'))
    hunks = sum(1 for line in git(dest, 'diff', '--diff-filter=M').splitlines() if line.startswith('@@ '))
    print(f'{name}: {count("ls-files")} files, {int(lines.group(1)) if lines else 0:,} lines, '
          f'{git(dest, "rev-list", "--count", "HEAD").strip()} commits; unstaged: '
          f'{count("diff", "--name-only", "--diff-filter=M")} modified files with {hunks} hunks, '
          f'{count("diff", "--name-only", "--diff-filter=D")} deleted, '
          f'{count("ls-files", "--others", "--exclude-standard")} untracked -> {dest}')


def fixtures(opts: argparse.Namespace) -> None:
    out = Path(opts.out).expanduser().resolve()
    for name in opts.only.split(','):
        if name not in SPECS:
            sys.exit(f'no fixture {name!r}, pick from {", ".join(SPECS)}')
        build(out, name, SPECS[name], opts.force)


# ---------------------------------------------------------------------------------------------------- run

@dataclass(frozen=True)
class App:
    bundle: Path
    flags: tuple[str, ...] = ()
    settings: dict[str, dict[str, object]] = field(default_factory=dict)
    # Electron keeps one instance per user data dir, so a clean profile can run beside the one in use
    beside: bool = False


# only what a first launch would stop on: restricted mode turns extensions off, and an update would replace the app
EDITOR_SETTINGS = {'security.workspace.trust.enabled': False, 'workbench.startupEditor': 'none', 'update.mode': 'none'}
APPS = {
    'codebaer': App(ROOT / 'workspace/backend/target/release/bundle/macos'),
    'vscode': App(Path('/Applications/Visual Studio Code.app'),
                  ('--user-data-dir', '{home}/vscode-data', '--extensions-dir', '{home}/vscode-extensions'),
                  {'vscode-data/User/settings.json': EDITOR_SETTINGS}, beside=True),
    'cursor': App(Path('/Applications/Cursor.app'),
                  ('--user-data-dir', '{home}/cursor-data', '--extensions-dir', '{home}/cursor-extensions'),
                  {'cursor-data/User/settings.json': EDITOR_SETTINGS}, beside=True),
    'zed': App(Path('/Applications/Zed.app'), ('--user-data-dir', '{home}/zed-data')),
    'smerge': App(Path('/Applications/Sublime Merge.app')),
}
BUCKETS = ('main', 'renderer', 'gpu', 'network', 'terminal', 'language-servers', 'ai', 'extensions', 'helper',
           'transient', 'shell')
SHELLS = {'zsh', 'bash', 'fish', 'sh', 'tcsh', 'nu', 'login'}
SERVERS = re.compile(r'tsserver|typescript-language-server|vtsls|rust-analyzer|language-?server|ServerMain'
                     r'|serverWorkerMain|eslint|gopls|pyright', re.I)
AGENTS = re.compile(r'copilot|cursor-?agent', re.I)

LIBC = ctypes.CDLL(None)
LIBC.responsibility_get_pid_responsible_for_pid.argtypes = [ctypes.c_int]
LIBC.proc_pid_rusage.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_void_p]


class RusageV4(ctypes.Structure):
    _fields_ = [('uuid', ctypes.c_uint8 * 16)] + [(name, ctypes.c_uint64) for name in (
        'user_time system_time pkg_idle_wkups interrupt_wkups pageins wired_size resident_size phys_footprint '
        'proc_start_abstime proc_exit_abstime child_user_time child_system_time child_pkg_idle_wkups '
        'child_interrupt_wkups child_pageins child_elapsed_abstime diskio_bytesread diskio_byteswritten '
        'cpu_time_qos_default cpu_time_qos_maintenance cpu_time_qos_background cpu_time_qos_utility '
        'cpu_time_qos_legacy cpu_time_qos_user_initiated cpu_time_qos_user_interactive billed_system_time '
        'serviced_system_time logical_writes lifetime_max_phys_footprint instructions cycles billed_energy '
        'serviced_energy interval_max_phys_footprint runnable_time').split()]


def memory(pid: int) -> tuple[int, int, int] | None:
    """Footprint, its peak over the process's life, and resident size, in bytes."""
    info = RusageV4()
    if LIBC.proc_pid_rusage(pid, 4, ctypes.byref(info)) != 0:
        return None
    return info.phys_footprint, info.lifetime_max_phys_footprint, info.resident_size


def nfc(text: str) -> str:
    return unicodedata.normalize('NFC', text)


def ps() -> dict[int, tuple[int, str]]:
    out = subprocess.run(['ps', '-axww', '-o', 'pid=,ppid=,comm='], capture_output=True, check=True).stdout
    procs = {}
    for line in out.decode(errors='replace').splitlines():
        parts = line.split(None, 2)
        if len(parts) == 3:
            procs[int(parts[0])] = (int(parts[1]), nfc(parts[2]))
    return procs


def args_of(pids: list[int]) -> dict[int, str]:
    if not pids:
        return {}
    out = subprocess.run(['ps', '-ww', '-o', 'pid=,args=', '-p', ','.join(map(str, pids))],
                         capture_output=True).stdout
    return {int(p[0]): nfc(p[1]) for p in (line.split(None, 1) for line in out.decode(errors='replace').splitlines())
            if len(p) == 2 and p[0].isdigit()}


def alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


def bucket(pid: int, main: int, comm: str, args: str) -> str:
    name = Path(comm).name
    if pid == main:
        return 'main'
    if name.lstrip('-') in SHELLS:
        return 'shell'
    if '--pty-host' in args or 'ptyHost' in args:
        return 'terminal'
    if AGENTS.search(args):
        return 'ai'
    if SERVERS.search(args):
        return 'language-servers'
    if 'WebContent' in name or '--type=renderer' in args:
        return 'renderer'
    if name.endswith('.GPU') or name == 'MTLCompilerService' or '--type=gpu-process' in args:
        return 'gpu'
    if 'Networking' in name or 'network.mojom' in args:
        return 'network'
    if '(Plugin)' in name or 'extensionHost' in args:
        return 'extensions'
    if name in ('git', 'claude', 'ssh'):
        return 'transient'
    return 'helper'


def members(main: int, procs: dict[int, tuple[int, str]]) -> set[int]:
    """The processes macOS holds the app responsible for, and their descendants."""
    found = {pid for pid in procs if pid == main or LIBC.responsibility_get_pid_responsible_for_pid(pid) == main}
    while True:
        more = {pid for pid, (ppid, _) in procs.items() if ppid in found} - found
        if not more:
            return found
        found |= more


class Sampler(threading.Thread):
    def __init__(self, main: int, interval: float) -> None:
        super().__init__(daemon=True)
        self.main, self.interval = main, interval
        self.phase = 'launch'
        self.rows: list[tuple] = []
        self.totals: list[tuple[float, str, int]] = []
        self.kinds: dict[tuple[int, str], tuple[str, str, str]] = {}
        self.done = threading.Event()
        self.began = time.monotonic()

    def members(self) -> tuple[set[int], dict[int, tuple[int, str]]]:
        procs = ps()
        return members(self.main, procs), procs

    def sample(self) -> None:
        found, procs = self.members()
        new = [pid for pid in found if (pid, procs[pid][1]) not in self.kinds]
        args = args_of(new)
        for pid in new:
            comm = procs[pid][1]
            line = args.get(pid, comm)
            self.kinds[(pid, comm)] = (bucket(pid, self.main, comm, line), Path(comm).name, line)
        t, phase, total = round(time.monotonic() - self.began, 2), self.phase, 0
        for pid in sorted(found):
            mem = memory(pid)
            if mem is None:
                continue
            kind, name, _ = self.kinds[(pid, procs[pid][1])]
            self.rows.append((t, phase, pid, kind, name, *mem))
            if kind != 'shell':
                total += mem[0]
        self.totals.append((t, phase, total))

    def run(self) -> None:
        while not self.done.is_set():
            began = time.monotonic()
            self.sample()
            self.done.wait(max(0.0, self.interval - (time.monotonic() - began)))

    def stable(self, window: int = 10, tolerance: float = 0.02) -> bool:
        recent = [total for _, _, total in self.totals[-window:]]
        return len(recent) == window and max(recent) - min(recent) <= tolerance * statistics.median(recent)


def bumped(text: str) -> str:
    lines = text.split('\n')
    for i in range(min(8, len(lines)), len(lines)):
        if NUM.search(lines[i]) and not lines[i].startswith(('import', 'use ', '#')):
            lines[i] = NUM.sub(lambda m: str(int(m.group()) + 1), lines[i], count=1)
            break
    return '\n'.join(lines)


class Churn(threading.Thread):
    """Acts like an agent: rewrites one tracked file every few seconds. Each file flips between its own text and a
    changed number, so the diff stays the same size and any growth in memory is the app's, not the diff's."""

    def __init__(self, repo: Path, every: float) -> None:
        super().__init__(daemon=True)
        self.repo, self.every, self.edits = repo, every, 0
        tracked = [p for p in git(repo, 'ls-files', '*.ts', '*.rs').splitlines() if (repo / p).exists()]
        if not tracked:
            sys.exit(f'{repo} has no tracked .ts or .rs file to churn')
        self.pool = tracked[::max(1, len(tracked) // 20)][:20]
        self.saved = {p: (repo / p).read_text() for p in self.pool}
        self.done = threading.Event()

    def run(self) -> None:
        while not self.done.wait(self.every):
            path = self.pool[self.edits % len(self.pool)]
            text = self.saved[path]
            (self.repo / path).write_text(bumped(text) if self.edits // len(self.pool) % 2 == 0 else text)
            self.edits += 1

    def finish(self) -> None:
        self.done.set()
        if self.is_alive():
            self.join()
        for path, text in self.saved.items():
            (self.repo / path).write_text(text)


def size_window(pid: int, size: tuple[int, int]) -> str | None:
    """Returns why the window could not be sized, or None once it is."""
    script = (f'tell application "System Events" to tell (first process whose unix id is {pid})\n'
              f'set position of window 1 to {{0, 25}}\nset size of window 1 to {{{size[0]}, {size[1]}}}\nend tell')
    result = subprocess.run(['osascript', '-e', script], capture_output=True, text=True)
    return None if result.returncode == 0 else result.stderr.strip() or 'osascript failed'


# CoreGraphics gives window bounds without the Automation permission that size_window needs
WINDOWS_JS = '''ObjC.import('AppKit');
function run(argv) {
  const pids = new Set(argv.map(Number));
  const screens = [];
  for (let i = 0; i < $.NSScreen.screens.count; i++) {
    const s = $.NSScreen.screens.objectAtIndex(i);
    screens.push({x: s.frame.origin.x, y: s.frame.origin.y, w: s.frame.size.width, h: s.frame.size.height,
                  scale: s.backingScaleFactor});
  }
  const top = screens[0].h;
  const list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(0, 0)));
  const real = w => w.kCGWindowLayer === 0 && w.kCGWindowBounds.Width >= 200 && w.kCGWindowBounds.Height >= 200;
  return JSON.stringify(list.filter(w => real(w) && pids.has(w.kCGWindowOwnerPID)).map(w => {
    const b = w.kCGWindowBounds, cx = b.X + b.Width / 2, cy = top - (b.Y + b.Height / 2);
    const screen = screens.find(s => cx >= s.x && cx < s.x + s.w && cy >= s.y && cy < s.y + s.h);
    return {pid: w.kCGWindowOwnerPID, width: b.Width, height: b.Height, scale: screen ? screen.scale : null,
            visible: Boolean(w.kCGWindowIsOnscreen)};
  }));
}'''


def windows(pids: set[int]) -> list[dict[str, object]]:
    """The app's windows, the scale of the display each is on, and whether it is on screen. A window on a 2x display
    has four times the pixels of the same window at 1x, and the renderer and GPU memory grow with them; a window on
    another Space is not on screen and may have dropped its buffers."""
    result = subprocess.run(['osascript', '-l', 'JavaScript', '-e', WINDOWS_JS, *map(str, sorted(pids))],
                            capture_output=True, text=True)
    return json.loads(result.stdout) if result.returncode == 0 else []


def window_label(window: dict[str, object]) -> str:
    return f'{window["width"]:.0f}x{window["height"]:.0f}@{window["scale"]}x' + ('' if window['visible'] else ' hidden')


def log_sizes(home: Path) -> dict[Path, int]:
    return {p: p.stat().st_size for p in (home / 'Library/Logs/com.codebaer.app').glob('*.log')}


def codebaer_ready(home: Path, before: dict[Path, int]) -> bool | None:
    """Whether the app logged that it opened the repo since the sizes in before, or None while its log is not under
    the clean home. The log is appended to by every run on the same day."""
    sizes = log_sizes(home)
    if not sizes:
        return None
    for path in sizes:
        with path.open('rb') as f:
            f.seek(before.get(path, 0))
            if re.search(r'webview: opened .+, \d+ changed file', f.read().decode(errors='replace')):
                return True
    return False


def stats(values: list[float]) -> dict[str, float]:
    return {'median_mb': round(statistics.median(values) / MB, 1), 'min_mb': round(min(values) / MB, 1),
            'max_mb': round(max(values) / MB, 1)}


def slope_mb_per_min(points: list[tuple[float, int]]) -> float | None:
    if len(points) < 3:
        return None
    mean_t = statistics.mean(t for t, _ in points)
    mean_v = statistics.mean(v for _, v in points)
    var = sum((t - mean_t) ** 2 for t, _ in points)
    return round(sum((t - mean_t) * (v - mean_v) for t, v in points) / var * 60 / MB, 2) if var else None


def summarize(sampler: Sampler) -> dict[str, object]:
    phases: dict[str, object] = {}
    for phase in dict.fromkeys(ph for _, ph, _ in sampler.totals):
        totals = [total for _, ph, total in sampler.totals if ph == phase]
        per_t: dict[float, dict[str, int]] = defaultdict(lambda: defaultdict(int))
        for t, ph, _, kind, _, footprint, _, _ in sampler.rows:
            if ph == phase:
                per_t[t][kind] += footprint
        buckets = {kind: round(statistics.median([s.get(kind, 0) for s in per_t.values()]) / MB, 1)
                   for kind in BUCKETS if any(kind in s for s in per_t.values())}
        phases[phase] = {'samples': len(totals), **stats(totals), 'buckets_mb': buckets}
    return phases


def launch(opts: argparse.Namespace) -> None:
    app = APPS[opts.app]
    bundle = app.bundle
    if opts.app == 'codebaer':
        built = sorted(bundle.glob('*.app'))
        if not built:
            sys.exit(f'no app bundle in {bundle}; run pnpm tauri build first')
        bundle = built[0]
    if not bundle.exists():
        sys.exit(f'{bundle} is not installed')
    info = plistlib.loads((bundle / 'Contents/Info.plist').read_bytes())
    exe = nfc(str(bundle / 'Contents/MacOS' / info['CFBundleExecutable']))
    repo = Path(opts.repo).expanduser().resolve()
    if not (repo / '.git').exists():
        sys.exit(f'{repo} is not a git repo')
    clean = opts.profile == 'clean'
    if opts.app == 'codebaer' and not clean:
        sys.exit("codebaer runs with --profile clean only: the real profile's terminal host holds your sessions")
    label = opts.label or ('churn' if opts.churn else 'manual' if opts.manual else 'idle')
    home = repo.parent / 'homes' / opts.app

    procs = ps()
    if opts.app == 'codebaer':
        # the single-instance plugin hands a second launch to any running CodeBär, a dev build too
        named = [pid for pid, (_, comm) in procs.items() if Path(comm).name in ('codebaer', 'CodeBär')]
        running = [pid for pid, args in args_of(named).items() if '--pty-host' not in args]
    else:
        running = [pid for pid, (_, comm) in procs.items() if comm == exe]
    if running and not (clean and app.beside):
        sys.exit(f'{info.get("CFBundleName", opts.app)} is already running (pid {", ".join(map(str, running))}); '
                 'quit it first, or the launch goes to it')

    if clean:
        if opts.fresh_home and home.exists():
            shutil.rmtree(home)
        home.mkdir(parents=True, exist_ok=True)
        for rel, settings in app.settings.items():
            if not (home / rel).exists():
                (home / rel).parent.mkdir(parents=True, exist_ok=True)
                (home / rel).write_text(json.dumps(settings, indent=2) + '\n')
        if opts.app == 'codebaer':
            hosts = [pid for pid, (_, comm) in procs.items() if Path(comm).name == 'codebaer']
            for pid, args in args_of(hosts).items():
                if '--pty-host' in args and str(home) in args:
                    os.kill(pid, signal.SIGTERM)

    logs_before = log_sizes(home)
    cmd = ['open', '-n', '-a', str(bundle)]
    if clean:
        cmd += ['--env', f'HOME={home}', '--env', f'CFFIXED_USER_HOME={home}']
    cmd += ['--args', *([f.format(home=home) for f in app.flags] if clean else []), str(repo)]
    subprocess.run(cmd, check=True)
    deadline = time.monotonic() + 30
    main = None
    while main is None:
        if time.monotonic() > deadline:
            sys.exit(f'{exe} did not start within 30s')
        time.sleep(0.25)
        main = next((pid for pid, (_, comm) in ps().items() if comm == exe and pid not in procs), None)
    started = datetime.now()
    print(f'{opts.app}: pid {main}, profile {opts.profile}{f" in {home}" if clean else ""}')

    sampler = Sampler(main, opts.interval)
    sampler.start()
    churn = None
    notes: list[str] = []
    window = opts.window
    window_state = 'left as is' if window is None else 'not sized'
    try:
        ready_at, attempts, log_seen = None, 0, opts.app != 'codebaer' or not clean
        while ready_at is None:
            time.sleep(1)
            waited = time.monotonic() - sampler.began
            if not alive(main):
                sys.exit(f'{opts.app} exited {waited:.0f}s after launch; a running instance may have taken it')
            if window is not None and window_state != 'sized' and waited >= 3 and attempts < 15:
                attempts += 1
                error = size_window(main, window)
                window_state = 'sized' if error is None else f'not sized: {error}'
            if not log_seen:
                seen = codebaer_ready(home, logs_before)
                if seen is None and waited > 30:
                    notes.append('no log under the clean home, so HOME did not reach the app; waited for a stable '
                                 'total instead')
                    log_seen = True
                elif seen:
                    log_seen = True
            if log_seen and waited >= 10 and sampler.stable():
                ready_at = waited
            elif waited > opts.ready_timeout:
                notes.append(f'the total never held within 2% for 10s in {opts.ready_timeout:.0f}s')
                ready_at = waited
        print(f'  ready after {ready_at:.0f}s, window {window_state}')
        if opts.manual:
            sampler.phase = 'manual'
            input(f'\n  Now: {opts.manual}\n  Press Enter when it is done... ')
        sampler.phase = 'settle'
        print(f'  settling {opts.settle:.0f}s')
        time.sleep(opts.settle)
        sampler.phase = 'measure'
        if opts.churn:
            churn = Churn(repo, opts.churn)
            churn.start()
        print(f'  measuring {opts.duration:.0f}s' + (f' while a file changes every {opts.churn:g}s' if churn else ''))
        time.sleep(opts.duration)
        if churn:
            churn.finish()
            sampler.phase = 'tail'
            print(f'  {churn.edits} edits done, measuring {opts.tail:.0f}s more')
            time.sleep(opts.tail)
        found, _ = sampler.members()
        shown = windows(found)
        try:
            detail = subprocess.run(['footprint', *map(str, sorted(found))], capture_output=True, text=True,
                                    timeout=120).stdout
        except subprocess.TimeoutExpired:
            detail = 'footprint did not finish within 120s\n'
    finally:
        if churn:
            churn.finish()
        sampler.done.set()
        sampler.join()
        leftovers = quit_app(main)

    out = repo.parent / 'results' / f'{started:%Y%m%d-%H%M%S}-{opts.app}-{opts.profile}-{repo.name}-{label}'
    out.mkdir(parents=True)
    with (out / 'samples.csv').open('w', newline='') as f:
        writer = csv.writer(f)
        writer.writerow(('t', 'phase', 'pid', 'bucket', 'name', 'footprint_mb', 'peak_mb', 'rss_mb'))
        for t, phase, pid, kind, name, footprint, peak, rss in sampler.rows:
            writer.writerow((t, phase, pid, kind, name, *(round(v / MB, 2) for v in (footprint, peak, rss))))
    (out / 'footprint.txt').write_text(detail)
    phases = summarize(sampler)
    last = max(t for t, ph, _ in sampler.totals if ph == 'measure')
    command_lines = {pid: line for (pid, _), (_, _, line) in sampler.kinds.items()}
    summary = {
        'app': opts.app, 'profile': opts.profile, 'repo': repo.name, 'label': label,
        'version': info.get('CFBundleShortVersionString'),
        'macos': subprocess.run(['sw_vers', '-productVersion'], capture_output=True, text=True).stdout.strip(),
        'started': started.isoformat(timespec='seconds'), 'ready_s': round(ready_at),
        'window': window_state, 'windows': shown,
        'settle_s': opts.settle, 'duration_s': opts.duration, 'interval_s': opts.interval,
        'churn': {'every_s': opts.churn, 'edits': churn.edits,
                  'slope_mb_per_min': slope_mb_per_min([(t, v) for t, ph, v in sampler.totals if ph == 'measure'])}
        if churn else None,
        'phases': phases,
        'processes': sorted(({'pid': pid, 'bucket': kind, 'name': name, 'mb': round(fp / MB, 1),
                              'args': command_lines.get(pid, '')[:400]}
                             for t, ph, pid, kind, name, fp, _, _ in sampler.rows if t == last),
                            key=lambda p: -p['mb']),
        'leftovers': leftovers, 'notes': notes,
    }
    (out / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
    measure = phases['measure']
    print(f'  total {measure["median_mb"]:.0f} MB median ({measure["min_mb"]:.0f}-{measure["max_mb"]:.0f}) '
          f'over {measure["samples"]} samples')
    print('  ' + '  '.join(f'{kind} {mb:.0f}' for kind, mb in measure['buckets_mb'].items()))
    print('  windows: ' + (', '.join(window_label(w) for w in shown) or 'none'))
    if churn:
        print(f'  churn: {summary["churn"]["slope_mb_per_min"]} MB/min while editing, '
              f'{phases["tail"]["median_mb"]:.0f} MB after')
    for note in notes + [f'left running after quit, stopped: {", ".join(leftovers)}'] * bool(leftovers):
        print(f'  note: {note}')
    print(f'  results: {out}')


def quit_app(main: int) -> list[str]:
    """Stops the app, then whatever it started that outlived it, such as CodeBär's terminal host. Returns those."""
    if alive(main):
        os.kill(main, signal.SIGTERM)
        deadline = time.monotonic() + 20
        while alive(main) and time.monotonic() < deadline:
            time.sleep(0.25)
        if alive(main):
            os.kill(main, signal.SIGKILL)
    time.sleep(2)
    procs = ps()
    left = sorted(members(main, procs) - {main})
    for pid in left:
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    return [f'{Path(procs[pid][1]).name} ({pid})' for pid in left]


# ---------------------------------------------------------------------------------------------------- report

def report(opts: argparse.Namespace) -> None:
    runs = [json.loads(p.read_text()) for p in sorted(Path(opts.dir).expanduser().glob('*/summary.json'))]
    if not runs:
        sys.exit(f'no runs in {opts.dir}')
    groups: dict[tuple[str, str, str, str], list[dict]] = defaultdict(list)
    for run in runs:
        groups[(run['repo'], run['label'], run['app'], run['profile'])].append(run)
    kinds = [kind for kind in BUCKETS if any(kind in r['phases']['measure']['buckets_mb'] for r in runs)]
    print('| repo | scenario | app | profile | runs | total MB | range | ' + ' | '.join(kinds) +
          ' | churn MB/min | window |')
    print('|' + ' --- |' * (9 + len(kinds)))
    for key in sorted(groups):
        group = groups[key]
        medians = [r['phases']['measure']['median_mb'] for r in group]
        cells = [statistics.median([r['phases']['measure']['buckets_mb'].get(kind, 0) for r in group])
                 for kind in kinds]
        slopes = [r['churn']['slope_mb_per_min'] for r in group if r.get('churn')]
        shown = sorted({window_label(max(r['windows'], key=lambda w: w['width'] * w['height']))
                        for r in group if r.get('windows')})
        print(f'| {" | ".join(key)} | {len(group)} | {statistics.median(medians):.0f} | '
              f'{min(medians):.0f}-{max(medians):.0f} | ' + ' | '.join(f'{c:.0f}' for c in cells) +
              f' | {statistics.median(slopes) if slopes else ""} | {", ".join(shown)} |')
    print('\nshell is left out of the total.')


def window_size(value: str) -> tuple[int, int] | None:
    if value == 'none':
        return None
    size = re.fullmatch(r'(\d+)x(\d+)', value)
    if not size:
        raise argparse.ArgumentTypeError(f"{value!r} is not WIDTHxHEIGHT or 'none'")
    return int(size.group(1)), int(size.group(2))


def main() -> None:
    parser = argparse.ArgumentParser(prog='pnpm mem', description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='command', required=True)
    f = sub.add_parser('fixtures', help='build the test repos')
    f.add_argument('--out', default=str(COMPARISON))
    f.add_argument('--only', default=','.join(SPECS))
    f.add_argument('--force', action='store_true', help='build the fixtures that exist again, from nothing')
    r = sub.add_parser('run', help='measure one app on one repo')
    r.add_argument('app', choices=APPS)
    r.add_argument('--repo', required=True)
    r.add_argument('--profile', choices=('clean', 'real'), default='clean')
    r.add_argument('--label', help='the scenario name in the report (default: idle, manual or churn)')
    r.add_argument('--manual', metavar='STEP', help='a step to do by hand once the app is ready, e.g. "open all diffs"')
    r.add_argument('--settle', type=float, default=30)
    r.add_argument('--duration', type=float, default=60)
    r.add_argument('--interval', type=float, default=1)
    r.add_argument('--churn', type=float, metavar='SECS', help='rewrite a tracked file every SECS while measuring')
    r.add_argument('--tail', type=float, default=60, help='with --churn, how long to measure after it stops')
    r.add_argument('--window', type=window_size, default='1440x900', help="WIDTHxHEIGHT, or 'none' to leave it")
    r.add_argument('--fresh-home', action='store_true', help='start the clean profile from nothing')
    r.add_argument('--ready-timeout', type=float, default=180)
    p = sub.add_parser('report', help='a table of every run')
    p.add_argument('dir', nargs='?', default=str(COMPARISON / 'results'))
    opts = parser.parse_args()
    {'fixtures': fixtures, 'run': launch, 'report': report}[opts.command](opts)


if __name__ == '__main__':
    main()
