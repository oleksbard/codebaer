# CodeBär

A small, fast macOS desktop editor for reviewing what an AI agent changed in a local git working tree. Review comes first, editing second. Git controls are built in. The agent runs outside the app, in your own terminal. The app watches the working tree and shows the unstaged changes as a queue of hunks. You accept, reject, or edit each hunk, then commit.

The whole idea in one sentence: **a staged hunk is a reviewed hunk.** Accept stages it, reject reverts it, edit changes the file. Git already has the two states the review needs. The app adds no state of its own.

## Requirements

- macOS 12 or later
- `git` on the PATH
- Rust toolchain (`rustup`)
- pnpm 12 (pinned in `package.json`, installed by corepack)

## Build and run

Install dependencies and start the development server:

```sh
pnpm install
pnpm tauri dev
```

Build the app:

```sh
pnpm tauri build
```

Run tests:

```sh
cargo test --manifest-path src-tauri/Cargo.toml
pnpm test
```

## Shell function

Add this to your shell configuration (`~/.zshrc`, `~/.bashrc`, etc.):

```sh
codebaer() { open -n -b com.codebaer.app --args "$(cd "${1:-.}" && pwd)"; }
```

It resolves the path in the shell, because a LaunchServices process does not inherit the shell's cwd. `-n` matters: without it, `open` on an already running app delivers nothing, verified with a throwaway bundle. With `-n` a second process starts, `tauri-plugin-single-instance` hands its argv to the running instance over its socket and exits, and the running instance opens that repo.

## Keyboard map

Hunks, at the cursor:

| Key | VS Code | Here |
| --- | --- | --- |
| Alt+F5 / Shift+Alt+F5 | next / previous change | next / previous hunk, continues into the next file in queue order at the end |
| F7 / Shift+F7 | diff editor next / previous difference | same, alias |
| Cmd+Y | chat edits: Keep this change | accept hunk |
| Cmd+N | chat edits: Undo this change | reject hunk |
| Cmd+K Cmd+Alt+S | Git: Stage selected ranges | accept hunk, alias |
| Cmd+K Cmd+R | Git: Revert selected ranges | reject hunk, alias |
| Cmd+K Cmd+N | Git: Unstage selected ranges | Staged view: unstage hunk |

Files:

| Key | VS Code | Here |
| --- | --- | --- |
| Cmd+Shift+Y | chat edits: Keep edits in this file | accept whole file |
| Cmd+Shift+N | chat edits: Undo edits in this file | reject whole file, with confirmation |
| Cmd+Alt+Y | chat edits: Keep all edits | Stage All |
| Cmd+Shift+] / Cmd+Shift+[ | next / previous editor | next / previous file in the queue |
| Cmd+P | Quick Open | open any file in the Plain view |
| Cmd+S | Save | flush autosave now |
| Cmd+Z | Undo | undo typing and rejects, not accepts |
| Cmd+F, Cmd+Alt+F, Ctrl+G | Find, Replace, Go to line | CodeMirror search and goto |

Panels and git:

| Key | VS Code | Here |
| --- | --- | --- |
| Ctrl+Shift+G | Source Control | Changes tab, focus the commit box |
| Cmd+Enter in the commit box | SCM: Commit | commit |
| Cmd+Shift+E | Explorer | Files tab, focus the tree |
| Cmd+B | Toggle sidebar | toggle the left column |
| Cmd+0 / Cmd+1 | focus sidebar / editor group | focus list / editor |
| Up, Down, Enter in a list | tree navigation | move, open |
| Cmd+Shift+P | Command Palette | Commit, Push, Pull, Checkout to, Stash, Pop Stash, Stage All, Unstage All, Discard All, Stage File, Discard File, Unstage File, Open Repository |
| Esc | | close palette, dismiss badge |

## Trust model

Opening a repository trusts it, exactly as `cd repo && git status` in a terminal does. Repo-local config can run code through `core.fsmonitor`, hooks, `credential.helper`, `core.askPass`, `diff.*.textconv`, and more, and the app does not try to sandbox git. Two consequences are stated so nobody assumes otherwise:

- The auto-open of the last repo at startup runs `git status` in it without asking. If you cloned something you do not trust, do not open it in CodeBär any more than you would run `git status` in it.
- Timeouts (section 4.3) exist so that a hostile or broken config hangs a command, not the app. They are not a security boundary.

## Before a release

Run on a scratch repo before each release.

1. `codebaer` in a repo directory opens it, header shows the branch, and `invoke` works under the CSP. Run it again from another repo while the app is open: the app switches to that repo.
2. In a terminal, change three files, add one, delete one. Queue shows five rows within a second. Open the deleted one: one deleted chunk. Cmd+Y stages the deletion (`git status` shows `D.`); Cmd+N on it instead brings the file back.
3. Alt+F5 walks hunks through the first file and into the second.
4. Cmd+Y on a hunk: the file appears in Staged and stays in Changes while unstaged hunks remain, `git diff --cached` shows the hunk.
5. Cmd+N on a hunk of a tracked file: the change is gone on disk, Cmd+Z brings it back. Cmd+N on the new untracked file: a confirmation appears; decline leaves the file, accept removes it.
6. Type into a hunk, wait, `cat` the file shows the edit. While typing, append a line to the same file from the terminal: the "changed on disk" badge appears and the file on disk still has the terminal's line.
7. Cmd+Shift+N on a half-accepted file: confirm dialog, the file matches `git show :path` afterwards and the Staged row stays.
8. Ctrl+Shift+G, type a message, Cmd+Enter: commit lands, Staged section empty.
9. Palette: Stash on a half-accepted file, then Pop Stash: the row is `MM` again.
10. Create a conflict via a pull or stash pop; the row shows the badge, the file opens in the conflict editor, staging after fixing clears it.
11. Open the Files tab: the whole repo is listed, opening a changed file shows the full current file, syntax highlighted, with "view changes" in the title bar.
12. Edit a shell script through the app: it stays executable.
13. Push with no agent and no credential helper: git's own error appears and the app stays responsive. With an unreachable host the push may sit on the connection; Cancel stops it.
14. `cargo tauri dev`: the app starts, `invoke` works, and hot reload works under `devCsp`.

Last run: not yet

## Known limits

Each is a deliberate simplification with a named upgrade path.

| Ceiling | Upgrade path |
| --- | --- |
| Full `git status -uall` on every refresh. During a `pnpm install` inside the tree that is one status per debounce window for minutes | pause the watcher while the queue is not visible; `core.untrackedCache` helps once the app stops using `--no-optional-locks`, which it now does |
| Watcher covers the whole tree including `node_modules` | same as above |
| Editor performance: the unified diff and WKWebView, not `read_file`, are the limit. Files over 2 MB get file-level actions only; a 1 MB minified bundle will still be slow | measure, then lower the limit or move the diff to a worker |
| Mixed line endings come back uniform | per-line EOL preservation if anyone hits it |
| Renames shown as delete plus add | rename rows when worth it |
| No user key bindings | `keybindings.json` when asked |
| Unsigned `.app`, TCC prompts per protected folder | signing and notarisation when distributing beyond the author |
| Branch against base is a separate read-only mode | design it when agents that commit become the common case |
