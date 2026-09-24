<p align="center"><img src="img/front.png" width="180" alt="CodeBär"></p>

# CodeBär

A small, fast macOS desktop editor for reviewing what an AI agent changed in a local git working tree. The agent runs outside the app, in your own terminal. The app watches the working tree and shows the unstaged changes as a queue of hunks. You accept, reject, or edit each hunk, then commit.

**A staged hunk is a reviewed hunk.** Accept stages it, reject reverts it, edit changes the file. Git already has the two states the review needs. The app adds no state of its own.

Select code in the editor to comment on it. Comments collect across files, and Send pastes them into one of the repo's claude or codex terminals, `claude:1` say, with each file, line range and quoted code, so the agent knows exactly what you mean. Right-click a file in the sidebar to copy its relative path.

## Requirements

- macOS 12 or later
- `git` on the PATH
- Rust toolchain (`rustup`)
- pnpm 12 (pinned in `package.json`, installed by corepack)

## Run

```sh
pnpm install
pnpm tauri dev
```

Open the current repo in an installed CodeBär from a terminal:

```sh
codebaer() { open -n -b com.codebaer.app --args "$(cd "${1:-.}" && pwd)"; }
```

## Build

```sh
pnpm tauri build
```

## Test

```sh
cargo test --manifest-path src-tauri/Cargo.toml
pnpm test
pnpm lint
```
