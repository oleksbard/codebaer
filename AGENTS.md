# AGENTS.md

CodeBär is a macOS desktop app (Tauri 2) for reviewing what an AI agent changed in a local git working tree. Unstaged changes appear as a queue of hunks. Accepting a hunk stages it, rejecting reverts it, and editing changes the file. There is also a built-in terminal and AI-written commit messages. User-facing docs are in `README.md`. The specs are in `docs/`: `*-codebaer-design.md` is the product spec, and `*-react-design-system-design.md` (UI layer) and `*-terminal-design.md` (terminals) take precedence over it in their own areas.

Naming: the product is "CodeBär", and the repo, crate, bundled executable and bundle id use `codebaer`. The cargo binary is `CodeBär`; `mainBinaryName` in `tauri.conf.json` renames it inside the bundle, because codesign cannot seal a bundle whose executable name has a precomposed `ä`. The folder name `reviewbaer` is older than the rename.

## Commands

```sh
pnpm install --frozen-lockfile
pnpm tauri dev                  # run the app
pnpm exec tsc --noEmit          # typecheck (tsconfig is strict, incl. noUncheckedIndexedAccess, exactOptionalPropertyTypes)
pnpm lint                       # oxlint --type-aware, then eslint (max-len 120 only)
pnpm test                       # vitest, jsdom
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
```

CI (`.github/workflows/ci.yml`) runs all of these, plus `pnpm tauri build --ci`, on macOS. On main it also drafts the release. Run the ones that cover your change before you call it done.

- Lint: oxlint does the real linting (`.oxlintrc.json`). It uses type-aware rules for unnecessary assertions and conditions and for floating or misused promises. ESLint runs only for `max-len`, parsed with babel because typescript-eslint does not support TypeScript 7 yet.
- Frontend tests: co-located `src/**/*.test.ts(x)`. Vitest is configured in `vite.config.ts`. `src/test-setup.ts` polyfills the DOM APIs that jsdom lacks and CodeMirror, Radix and xterm need. Tests mock the local wrapper modules (`vi.mock('./git')`, `./terminal`), not `@tauri-apps/api`. Components are rendered with `react-dom/client` directly, without testing-library.
- Rust tests: inline `#[cfg(test)]` modules for pure helpers. Integration tests in `src-tauri/tests/` run real git repos and a real pty host.

## Architecture

```
src/                     React 19 + TypeScript frontend (Vite)
  main.tsx               entry: initTheme(), start(); start() is skipped under Vitest
  app/store.ts           the single mutable state object `S`, `notify()`, `useApp()`
  app/controller.ts      actions: refresh, open, accept/reject, commit, network, terminals, keybindings
  app/*.tsx              shell components (App, Shell, Sidebar, Main, Terminals, Overlays)
  git.ts                 the only invoke() wrapper for git commands, AppError type, errText()
  terminal.ts            invoke wrapper for term_* commands, owns the xterm instances
  model.ts               pure review logic (queue building, accept/reject text, refresh decisions)
  keys.ts                keymap: key event to Action, dispatched by controller.dispatch()
  palette.ts, toast.ts, log.ts   command palette/picker, toasts, logging to the backend
  editor*.ts, context-view.ts   CodeMirror merge view, language loading, theme
  ui/                    presentational primitives (Radix-based) and the token/theme system
  styles/                page CSS, split by area
src-tauri/src/           Rust backend
  lib.rs                 app bootstrap, native menu, plugins, the generate_handler![] command list
  main.rs                also serves as the detached pty host when started with --pty-host
  git.rs                 every git operation; runs the `git` CLI (no libgit2), holds AppState
  status.rs, eol.rs      porcelain status parser, line-ending handling
  error.rs               AppError, serialized as {kind, detail}
  watcher.rs             `notify` watcher on the worktree and .git, debounced, emits `repo-changed`
  ai.rs                  commit messages from the local `claude` CLI over `git diff --cached`
  recents.rs, logs.rs    recent repos, file logging
  pty/                   terminals: daemon.rs (detached host that owns the PTYs, on a Unix socket),
                         client.rs (term_* commands, forwards frames over a Tauri Channel),
                         proto.rs (wire protocol), osc133.rs, ring.rs, shells.rs
```

Data flow: the watcher emits `repo-changed`, which reaches `listen()` in `controller.start()`. That calls `refresh()`, which calls `git.status()` (Rust `status` command, then `git status`, then `status::parse`). The result goes into `S.status`, `notify()` fires, and the components re-render and read `S` directly.

## Invariants

- The app keeps no review state of its own. The git index is the "reviewed" state. Do not add a parallel store for it.
- `S` is changed in place. Every change must be followed by `notify()`, or the UI goes stale without any error.
- Actions that change git go through `guarded(name, fn)` in `controller.ts`, which flushes a dirty buffer, shows the busy state and refreshes afterwards. Do not call `git.*` mutations directly from components.
- Async code that writes to `S` after an `await` must check `S.openEpoch` (the `stale()` pattern) so a late result cannot overwrite a newer view.
- File writes carry an expected baseline. A conflict comes back as `Stale` or `StaleIndex` and must be shown to the user, never overwritten silently.
- Adding a Tauri command: implement it in its module, add it to `generate_handler![]` in `lib.rs`, and add a wrapper in `src/git.ts` or `src/terminal.ts`. `capabilities/default.json` only needs a change for core or plugin permissions.
- Adding a variant to `AppError` in `error.rs`: add the matching case to the TS `AppError` union and `KIND_TEXT` in `src/git.ts`. Without them the type check misses it and the user sees the raw kind name.
- Use the design tokens from `src/ui/tokens.css` and `themes.css` in CSS. Do not hardcode colors.

## Versioning and releases

- The version lives only in `src-tauri/Cargo.toml`; `tauri.conf.json` has none and falls back to it. Never edit it by hand.
- A change a user can notice includes a bump in the same change: `pnpm bump minor` for a feature, `pnpm bump patch` for a fix. Docs, tests, CI and refactors get none. Never `major`, that is the owner's call.
- `scripts/bump.mjs` counts from the last published release, the newest `v*` tag on origin. Repeating a bump within one release cycle changes nothing, and a feature after a fix raises the patch to a minor. It only reads git, fails without changing anything when origin is unreachable, and rewrites `Cargo.toml` and `Cargo.lock`.
- Never create tags or releases. A push to main with an unreleased version makes CI build the draft release, and the owner publishes it. `README.md`, "Releasing", has the flow; `install.sh` is what its install one-liner runs.
- Builds are macOS on Apple Silicon only. The approach for Linux and Windows is in `docs/2026-09-25-linux-windows-support-design.md`.

## Boundaries

- Never run git commands that write (commit, push, branch, stash, reset and so on). The owner does all git operations. Read-only git commands are fine.
- Superpowers plans and other working notes go under `~/.claude/`, not in the repo. `docs/` holds only docs the owner asked for.
- Ask before adding a dependency or changing `tauri.conf.json` or the capabilities file.
