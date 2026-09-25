<p align="center"><img src="img/front.png" width="180" alt="CodeBär"></p>

# CodeBär

A small, fast macOS desktop app for reviewing what an AI agent changed in a local git working tree. Run the agent in the app's built-in terminal or in your own. The app shows the unstaged changes as a queue of hunks. You accept, reject, or edit each hunk, then commit.

## Install

Apple Silicon Macs only, for now. `git` has to be on the PATH. To install or update to the latest release:

```sh
curl -fsSL https://raw.githubusercontent.com/oleksbard/codebaer/main/install.sh | sh
```

The app is ad-hoc signed, not notarized. `curl` does not mark its downloads as quarantined, so Gatekeeper never checks the app and it opens normally. If you download the `.dmg` from the [releases page](https://github.com/oleksbard/codebaer/releases) in a browser instead, macOS blocks the first launch. Allow it under System Settings, Privacy & Security, Open Anyway, or clear the flag:

```sh
xattr -dr com.apple.quarantine /Applications/CodeBär.app
```

Every build has a new ad-hoc signature, so after an update macOS asks again for access to protected folders such as Documents or Desktop.

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
