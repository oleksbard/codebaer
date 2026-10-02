<p align="center"><img src="img/front.png" width="180" alt="CodeBär"></p>

# CodeBär

A small, fast desktop app for macOS, and for Linux as a beta, for reviewing what an AI agent changed in a local git working tree. Run the agent in the app's built-in terminal or in your own. The app shows the unstaged changes as a queue of hunks, one file at a time or every file on one page. You accept, reject, or edit each hunk, then commit.

![CodeBär demo](https://github.com/user-attachments/assets/a563d1a6-d363-4ee7-acc4-300daca14d70)

## Why

Git tools assume you wrote the change yourself. With an agent, someone else is editing your working tree, often while you read it. CodeBär is built for that case.

- **A staged hunk is a reviewed hunk.** Accept stages it, reject reverts it.
- **Talk back to the agent.** Select lines, write a comment, and send one or a batch to the agent's terminal, with the code quoted.
- **Any agent.** It reads the working tree, not an agent session, so it works with Claude Code, Codex, OpenCode, or anything else that edits files.

## Install

Apple Silicon Macs, and x86_64 Linux as a beta. The review needs `git` on the PATH. Without it, or in a folder with no
repository, CodeBär opens the folder for its terminals and tasks only. To install or update to the latest release:

```sh
curl -fsSL https://raw.githubusercontent.com/oleksbard/codebaer/main/install.sh | sh
```

### macOS

The app isn't notarized, since it's a free side project. Installed with the script, it opens normally. If you download the `.dmg` from the [releases page](https://github.com/oleksbard/codebaer/releases) in a browser instead, macOS blocks the first launch. Allow it under System Settings, Privacy & Security, Open Anyway, or run:

```sh
xattr -dr com.apple.quarantine /Applications/CodeBär.app
```

From 0.5.0 the app updates itself: a little after it starts and every few hours it looks for a new release, and a button in the header then downloads and installs it and restarts the app. Running terminals carry over unless the release says otherwise. Settings, General, Check for updates turns this off.

Every build has a new ad-hoc signature, so after an update macOS asks again for access to protected folders such as Documents or Desktop.

### Linux (beta)

There is a `.deb` for Ubuntu 22.04, Debian 12 and later, and an `.rpm` for Fedora and openSUSE. On Linux the script above downloads the right one, checks it, and prints the `apt`, `dnf` or `zypper` command that installs it. You can also download a package from the [releases page](https://github.com/oleksbard/codebaer/releases) and install it yourself. The shortcuts use Ctrl instead of Cmd. In a terminal, plain Ctrl keys go to the shell, and the app's own keys there are Ctrl+Shift, as in a Linux terminal: Ctrl+Shift+C and Ctrl+Shift+V copy and paste. CI tests each release on Ubuntu, on X11 and Wayland, and on Fedora, but it is tried less than the Mac app, so please [open an issue](https://github.com/oleksbard/codebaer/issues) for anything that breaks.

## Requirements

- macOS 12 or later, or Linux with WebKitGTK 4.1 and the other packages [Tauri lists](https://v2.tauri.app/start/prerequisites/#linux) (`.github/workflows/linux.yml` installs them on Ubuntu, and zsh for the tests)
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
cargo test --manifest-path workspace/backend/Cargo.toml
pnpm test
pnpm lint
```

## License

[MIT](LICENSE)
