# AGENTS.md

CodeBär is a macOS desktop app (Tauri 2) for reviewing what an AI agent changed in a local git working tree. Unstaged changes appear as a queue of hunks. Accepting a hunk stages it, rejecting reverts it, and editing changes the file. There is also a built-in terminal and AI-written commit messages. User-facing docs are in `README.md`. The specs are in `docs/`: `*-codebaer-design.md` is the product spec, and `*-react-design-system-design.md` (UI layer) and `*-terminal-design.md` (terminals) take precedence over it in their own areas.

Naming: the product is "CodeBär", and the repo, crate, bundled executable and bundle id use `codebaer`. The cargo binary is `CodeBär`; `mainBinaryName` in `tauri.conf.json` renames it inside the bundle, because codesign cannot seal a bundle whose executable name has a precomposed `ä`. The folder name `reviewbaer` is older than the rename.

## Commands

```sh
pnpm install --frozen-lockfile
pnpm tauri dev                  # run the app
pnpm typecheck                  # tsc in workspace/ui over src (strict, incl. noUncheckedIndexedAccess,
                                # exactOptionalPropertyTypes), then over the Playwright specs, which need node types
                                # that src must not see
pnpm lint                       # oxlint --type-aware, then eslint (max-len 120 only), in workspace/ui
pnpm test                       # vitest: workspace/ui on jsdom, scripts/ on node
pnpm e2e                        # Playwright against browser mode, WebKit then Chromium (--project=webkit for one)
pnpm ui                         # browser mode: the app on a fake backend at localhost:1430/mock.html
pnpm shot [scenario] [--theme id] [--do press:Meta+T]   # PNG of browser mode, into workspace/ui/test-results/shots/
cargo clippy --manifest-path workspace/backend/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path workspace/backend/Cargo.toml
```

CI (`.github/workflows/ci.yml`) runs all of these on macOS except `ui` and `shot`, with `e2e` in WebKit only, plus `pnpm tauri build --ci` and `scripts/smoke.sh`, which starts the built app on a scratch repo and fails unless the webview logs that it opened it, the app is still running a moment later, and nothing logged an error. The smoke script runs only in CI, because it uses the machine's real app data and kills every pty host. On main CI also drafts the release. Run the ones that cover your change before you call it done.

- Lint: oxlint does the real linting (`workspace/ui/.oxlintrc.json`). It uses type-aware rules for unnecessary assertions and conditions and for floating or misused promises. ESLint runs only for `max-len`, parsed with babel because typescript-eslint does not support TypeScript 7 yet.
- Frontend tests: co-located `workspace/ui/src/**/*.test.ts(x)`. Vitest runs from the root `vitest.config.ts`, which lists the ui project (configured in `workspace/ui/vite.config.ts`) and `scripts/`. `workspace/ui/src/test-setup.ts` polyfills the DOM APIs that jsdom lacks and CodeMirror, Radix and xterm need. Tests mock the local wrapper modules (`vi.mock('#ipc/git')`, `#ipc/terminal`), not `@tauri-apps/api`. A test that mounts the whole app uses `mountApp()` and the fixtures in `workspace/ui/src/test-app.ts`, and keeps its own `vi.mock` calls, since Vitest hoists them per file. Components are rendered with `react-dom/client` directly, without testing-library.
- Rust tests: inline `#[cfg(test)]` modules for pure helpers. Integration tests in `workspace/backend/tests/` run real git repos and a real pty host.
- End-to-end tests: `workspace/ui/e2e/*.spec.ts`, Playwright, configured in `workspace/ui/playwright.config.ts`, which starts Vite on port 1430. The `open` fixture loads a scenario, and any console error fails the test. Assert on the fake repo with `mock.state()` and wait with `mock.idle()` rather than timeouts.

## Browser mode

`workspace/ui/mock.html` runs the real frontend in a browser on a fake backend, so a UI change can be seen and tested without Tauri. `workspace/ui/src/mock/boot.ts` installs `mockIPC` from `@tauri-apps/api/mocks`, then loads `main.tsx` unchanged. `vite build` bundles only `index.html`, so nothing under `workspace/ui/src/mock/` ships.

- `backend.ts`: one handler per command in `generate_handler![]`, plus the folder picker. `backend.test.ts` fails when the two lists differ. It fires `repo-changed` after each change like the watcher, and exposes `window.__mock`: `agentEdit`, `fail`, `state`, `idle`, `emit`, `menu`, `calls`, `terminalText`.
- `repo.ts`: an in-memory repo, HEAD, index and working-tree text per file. It follows `git.rs` and `status.rs`, including the `Stale` and `StaleIndex` refusals.
- `pty.ts`: a pretend terminal host speaking the same `ServerMsg` and output frames, with a line shell (`echo`, `ls`, `git status`, `sleep`, `exit`).
- `scenarios.ts`: `?scenario=` is `review` (default), `clean`, `conflict`, `terminals`, `no-repo` or `no-git`. `&theme=<id>` picks a theme, `&slow=<ms>` sets how long push, pull, fetch and the AI message take (default 800), `&latency=<ms>` delays every call.
- It cannot catch real git or pty behaviour, argument names that Rust would reject (the mock gets the raw JS object), the native menu, dialogs and window chrome, the CSP, or WKWebView-only quirks. The Rust tests and `scripts/smoke.sh` still own those.

### Rendering pages as an agent

Agents can use browser mode to render any screen of the app with mock data and look at it. You do not need Tauri, a real repository or a display. Use it to check a UI change before you call it done, and to see a screen before you change it.

- One screenshot: `pnpm shot <scenario> [--theme id] [--out file]` starts Vite, renders the scenario in headless WebKit, waits until the fake backend is idle, and saves a PNG (default `workspace/ui/test-results/shots/<scenario>.png`; pnpm runs the script in `workspace/ui/`, so a relative `--out` is relative to that folder). Read the PNG to see the page.
- Another screen: add `--do` steps, which run in order and each wait for idle again. `press:<keys>` sends a key chord, `click:<selector>` clicks a Playwright locator, and `type:<text>` types. For example, `pnpm shot review --do press:Meta+Shift+T` shows the terminals, and `pnpm shot review --do press:Meta+Shift+P` shows the palette.
- Other data: pick the scenario that has what you need, or add a scenario to `scenarios.ts` when none has it. Add `--theme <id>` to check a light or dark theme, and `--browser chromium` to compare engines.
- Interactive: run `pnpm ui` and open `http://localhost:1430/mock.html?scenario=<name>` with the Playwright MCP server or any browser tool. Call `window.__mock` to change the data while the page is open, for example `agentEdit` to simulate an agent writing a file.
- `pnpm shot` exits non-zero when the page logs an error, so a broken render cannot pass as a clean screenshot.

## Architecture

The repo is a pnpm workspace. `workspace/ui` is the frontend package `@codebaer/ui` and `workspace/backend` is the Tauri crate. The root `package.json` passes `dev`, `build`, `typecheck`, `lint`, `ui`, `e2e` and `shot` through to the ui package and runs vitest over it and `scripts/`.

```
workspace/ui/src/        React 19 + TypeScript frontend (Vite)
  main.tsx               entry: state, keymap, initTheme(), start(); start() is skipped under Vitest
  test-setup.ts          DOM polyfills jsdom lacks; loads the state and the keymap for every test
  test-app.ts            harness for tests that mount the whole app: mountApp(), fixtures, openUnstaged()
  ui/                    presentational primitives (Radix-based; List.tsx for the queue and the tree), tokens,
                         themes
  editor/                CodeMirror toolkit: merge view, language loading, theme, changes-only folds and the
                         keepVisible facet; no app state
  ipc/                   every invoke(), Channel and event wrapper: git.ts (git commands, AppError, errText),
                         terminal.ts (term_* and task_run commands), settings.ts (settings-file wire types, the
                         backend's defaults), log.ts, events.ts, dialog.ts
  mock/                  browser mode: fake backend, repo, terminal host and scenarios (see Browser mode); may
                         import only ipc/ and ui/, except boot.ts loading the app through #main
  kernel/                app infrastructure, no feature code:
    store.ts             the single mutable state object `S` (its fields are declared by core, feature and app
                         state.ts files), `notify()`, `useApp()`
    registry.ts          defineFeature(): commands, events, overlays, editor extensions, hooks; the palette
    keymap.ts            the key engine: matching, contexts, the Cmd-K chord, keyLabel(), matches()
    pick.ts, dialogs.ts  command palette/picker; toasts, confirm, prompt
    epoch.ts             the stale-result check for async work
    platform.ts          which platform the frontend runs on
    paths.ts             every platform path rule the frontend has (home root, base name, inside a folder)
    clipboard.ts         copy a path, and the menu item the queue and the tree share
    sleep.ts             a timed wait
  core/                  the review session every feature shares:
    session.ts           refresh, open, autosave, guarded, repo switching, the shared editor view
    model.ts             pure review logic (queue building, accept/reject text, refresh decisions)
    state.ts             repo, status, open file, tab
    feature.ts           core's commands and backend events
  features/              one folder per feature; index.ts holds its defineFeature() and its public API, state.ts
                         its fields on `State`:
    review/              hunk and file actions (hunks.ts), blame (blame.ts), the review pane, the change queue
    comments/            review comments for an agent: anchoring and paste format (comments.ts), the editor marks
                         and widgets (editor-comments.ts), actions, the draft box, cards and the pending pill
    terminals/           xterm instances (xterm.ts), session events and actions (sessions.ts, with the taskEvents
                         seam the runner hooks), status labels (status.ts), the pane and the rail
    orphans/             the debug finder for stale terminal hosts and orphaned sessions: scan rows (orphans.ts),
                         actions, the dialog
    tasks/               runs saved commands and package.json scripts: the command menu, the output dialog with
                         its live terminal (runner.ts hooks the terminals' taskEvents seam)
    git-ops/             commit, AI message, push/pull/fetch, stash, branches (git-ops.ts), the commit box
    files/               the Files tab: listing, ignored directories read on demand, quick open (files.ts), the tree
    repos/               the repo switcher in the header, recent repos and their avatars
    settings/            owns the settings file: the options catalog, loading and saving (settings.ts), the saved
                         commands (commands.ts), the dialog, the theme picker and the Commands pane
  app/                   composition only:
    App.tsx, Shell.tsx, Sidebar.tsx   the window, the header and sidebar gutter, the sidebar frame and activity bar
    OverlayHost.tsx      palette, confirm, prompt, then every registered overlay; toasts and the chord hint
    features.ts          the feature list, in palette order
    bootstrap.ts         register(), start()
    state.ts             sets every declared field's initial value
    actions.ts           app-level actions: tab switch, sidebar toggle and width
    keymap/              the binding tables, one per platform (mac.ts)
    styles.css           imports every folder's CSS in cascade order; base, layout, panes and overlays CSS
workspace/backend/src/   Rust backend
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

Data flow: the watcher emits `repo-changed`, which reaches core's `repo-changed` event handler (subscribed by `listenAll()` in `app/bootstrap.ts`). That calls `refresh()` in `core/session.ts`, which calls `git.status()` (`ipc/git.ts`) (Rust `status` command, then `git status`, then `status::parse`). The result goes into `S.status`, `notify()` fires, and the components re-render and read the state through `useApp()`.

Layers, enforced by lint (`workspace/ui/.oxlintrc.json`); a later override wins:

| Layer | May import |
|---|---|
| `ui/` | external packages |
| `ipc/` | external packages, `#ui/*` (the `Settings` wire type carries `Theme`) |
| `editor/` | external packages, `#ui/*`, `#ipc/*` |
| `mock/` | external packages, `#ipc/*`, `#ui/*`; `boot.ts` loads the app through `#main` |
| `kernel/` | `ipc/`, `ui/` |
| `core/` | `kernel/`, `ipc/`, `editor/`, `ui/` |
| `features/x/` | the layers above, and another feature only through `#features/y` (its `index.ts`); never `#app/*` |
| `app/` | everything |

Across folders every import goes through a `#` key from `workspace/ui/package.json`; `../` is banned everywhere in `src/`. Inside a folder, `./`. `#features/*` resolves to a feature's `index.ts`, and lint bans a deep import into another feature; only `app/state.ts` uses the `#features/*/state` key. A feature's tests may also import `#app/*`, to mount the host or the sidebar they render into. No import cycles (`import/no-cycle`).

Adding a feature:
- Create `workspace/ui/src/features/<name>/` with `index.ts` exporting its `defineFeature()` and its public API, and `state.ts` if it has state.
- Add it to `app/features.ts`, and its state to `app/state.ts`.
- Add its key rows to each `app/keymap/*.ts` table, and its CSS import to `app/styles.css`.
- Add the folder nowhere else: the lint globs already cover `src/features/**`.

## Invariants

- The app keeps no review state of its own. The git index is the "reviewed" state. Do not add a parallel store for it.
- `S` is changed in place. Every change must be followed by `notify()`, or the UI goes stale without any error. Components never write it: `useApp()` returns it read-only, lint bans importing `S` in `.tsx`, and a component changes state through an action.
- State is declared where it is owned: a feature's `state.ts` adds its fields to `State` by declaration merging and returns their initial values, and `app/state.ts` sets them all. A state module imports only types and modules no test mocks.
- A feature is registered, not wired by hand: its commands, backend events, overlays, editor extensions and hooks (`onOpen`, `onRefresh`, `onRepoChange`) go in its `defineFeature()`, and `app/features.ts` lists the features in order. The palette, key and menu dispatch, the overlay host and the repo switch read the registry. Don't call a feature from core or add a case to a shared switch.
- Key bindings live in one table per platform (`app/keymap/mac.ts`), not on commands, and every shortcut label comes from `keyLabel()`. A component with its own key handler lists its keys as `local` rows and tests them with `matches()`. The table test fails on two bindings that could fire in the same place.
- Actions that change git go through `guarded(name, fn)` in `core/session.ts`, which flushes a dirty buffer, shows the busy state and refreshes afterwards. Do not call `git.*` mutations directly from components.
- Async work that writes state after an await takes a check from an `epoch()` (`kernel/epoch.ts`) before the await and returns when it is false, or checks that the record it started on is still `S.open`, so a late result cannot overwrite a newer view.
- File writes carry an expected baseline. A conflict comes back as `Stale` or `StaleIndex` and must be shown to the user, never overwritten silently.
- Adding a Tauri command: implement it in its module, add it to `generate_handler![]` in `lib.rs`, add a wrapper in `workspace/ui/src/ipc/git.ts` or `workspace/ui/src/ipc/terminal.ts`, and add its handler in `workspace/ui/src/mock/backend.ts`. `capabilities/default.json` only needs a change for core or plugin permissions.
- Adding a variant to `AppError` in `error.rs`: add the matching case to the TS `AppError` union and `KIND_TEXT` in `workspace/ui/src/ipc/git.ts`. Without them the type check misses it and the user sees the raw kind name.
- Use the design tokens from `workspace/ui/src/ui/tokens.css` and `themes.css` in CSS. Do not hardcode colors.

## Versioning and releases

- The version lives only in `workspace/backend/Cargo.toml`; `tauri.conf.json` has none and falls back to it. Never edit it by hand.
- A change a user can notice includes a bump in the same change: `pnpm bump minor` for a feature, `pnpm bump patch` for a fix. Docs, tests, CI and refactors get none. Never `major`, that is the owner's call.
- `scripts/bump.mjs` counts from the last published release, the newest `v*` tag on origin. Repeating a bump within one release cycle changes nothing, and a feature after a fix raises the patch to a minor. It only reads git, fails without changing anything when origin is unreachable, and rewrites `Cargo.toml` and `Cargo.lock`.
- Never create tags or releases. A push to main with an unreleased version makes CI build the draft release, replacing the previous draft. `.github/workflows/release.yml` publishes it on Mondays and Thursdays (UTC) once it is 12 hours old and still built from main's head, and the owner can publish it earlier from the releases page. Publishing creates the tag. `install.sh` is what the README's install one-liner runs.
- Builds are macOS on Apple Silicon only. The approach for Linux and Windows is in `docs/2026-09-25-linux-windows-support-design.md`.

## Boundaries

- Never run git commands that write (commit, push, branch, stash, reset and so on). The owner does all git operations. Read-only git commands are fine.
- Superpowers plans and other working notes go under `~/.claude/`, not in the repo. `docs/` holds only docs the owner asked for.
- Ask before adding a dependency or changing `tauri.conf.json` or the capabilities file.
- Lint enforces the import direction between folders (`.oxlintrc.json` overrides).
