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

The app isn't notarized, since it's a free side project. If you download the `.dmg` from the [releases page](https://github.com/oleksbard/codebaer/releases) in a browser instead, macOS blocks the first launch. Allow it under System Settings > Privacy & Security > Open Anyway, or run:

```sh
xattr -dr com.apple.quarantine /Applications/CodeBär.app
```

App updates itself (with your permission).

### Linux (beta)

There is a `.deb` for Ubuntu 22.04, Debian 12 and later, and an `.rpm` for Fedora and openSUSE. 

```sh
curl -fsSL https://raw.githubusercontent.com/oleksbard/codebaer/main/install.sh | sh
```

You can also download a package from the [releases page](https://github.com/oleksbard/codebaer/releases) and install it yourself.

## Requirements

- macOS 12 or later, or Linux with WebKitGTK 4.1 and the other packages [Tauri lists](https://v2.tauri.app/start/prerequisites/#linux) (`.github/workflows/linux.yml` installs them on Ubuntu, and zsh for the tests)
- `git` on the PATH
- Rust toolchain (`rustup`)
- pnpm 12 (pinned in `package.json`, installed by corepack)

## License

[MIT](LICENSE)
