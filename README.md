<p align="center"><img src="img/front.png" width="180" alt="CodeBär"></p>

# CodeBär

A small, fast macOS desktop app for reviewing what an AI agent changed in a local git working tree. Run the agent in the app's built-in terminal or in your own. The app shows the unstaged changes as a queue of hunks. You accept, reject, or edit each hunk, then commit.

## Install

Apple Silicon Macs only, for now. `git` has to be on the PATH. To install or update to the latest release:

```sh
curl -fsSL https://raw.githubusercontent.com/oleksbard/codebaer/main/install.sh | sh
```

The script downloads the latest release, checks it against the release's `SHA256SUMS.txt`, and updates `CodeBär.app` where it is already installed. A first install goes to `/Applications`, or to `~/Applications` when `/Applications` is not writable. Quit CodeBär before you update. To read the script before you run it:

```sh
curl -fsSLO https://raw.githubusercontent.com/oleksbard/codebaer/main/install.sh
less install.sh
sh install.sh
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

## Releasing

CI cuts releases from main (`.github/workflows/ci.yml`). Nobody tags by hand.

1. A change a user can notice carries its own version bump: `pnpm bump minor` for a feature, `pnpm bump patch` for a fix. The version lives only in `src-tauri/Cargo.toml`, and the bump counts from the last published release, so several changes between releases add up to one bump. `AGENTS.md` has the rule.
2. A push to main whose version has no release yet builds the draft release `vX.Y.Z`: the `.dmg`, the app tarball that `install.sh` fetches, and `SHA256SUMS.txt`, with the commit subjects since the last release as notes. Each later push to main replaces the draft, notes included.
3. Download the `.dmg` from the draft and run the manual smoke checklist (design spec, section 12).
4. Check that the draft still targets the commit you tested, edit the notes, and publish it. Publishing creates the tag, and `install.sh` serves the new release from then on. A later push to main that keeps the version drafts nothing; its changes ship with the next bump.
