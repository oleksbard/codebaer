#!/usr/bin/env bash
# Starts the bundled app on a scratch repo. Fails unless the webview logs that it loaded the repo, the app is still
# running a moment later, and nothing logged an error. CI only: it runs on this user's real app data and logs, and
# kills every pty host when it is done.
set -euo pipefail

if [ -z "${CI:-}" ]; then
  echo "smoke.sh runs in CI only: here it would open a scratch repo in your CodeBär and end your terminal sessions" >&2
  exit 1
fi

os=$(uname -s)
if [ "$os" = Darwin ]; then
  apps=(workspace/backend/target/release/bundle/macos/*.app)
  exe="$PWD/${apps[0]}/Contents/MacOS/codebaer"
  logs="$HOME/Library/Logs/com.codebaer.app"
else
  # the installed .deb, so the smoke covers what the package put in place; it needs a display, which CI gives it
  # with xvfb-run
  exe=/usr/bin/codebaer
  logs="${XDG_DATA_HOME:-$HOME/.local/share}/com.codebaer.app/logs"
fi
# SMOKE_TAG keeps a second run on the same machine, such as under Wayland, from overwriting the first one's files
out="${RUNNER_TEMP:?}/smoke${SMOKE_TAG:+-$SMOKE_TAG}"
mkdir -p "$out"

fail() {
  echo "::error::smoke: $1"
  cat "$logs"/*.log 2>/dev/null || cat "$out/app.out" 2>/dev/null || true
  exit 1
}

[ -x "$exe" ] || fail "no app bundle at $exe"

# resolved, as the app logs it: macOS's temp folder is under a symlink
repo=$(cd "$(mktemp -d)" && pwd -P)
git -C "$repo" init -q
echo one > "$repo/a.txt"
git -C "$repo" add a.txt
git -C "$repo" -c user.name=smoke -c user.email=smoke@example.invalid commit -qm init
echo two > "$repo/a.txt"

"$exe" "$repo" > "$out/app.out" 2>&1 &
app=$!
finish() {
  kill "$app" 2>/dev/null || true
  pkill -f -- ' --pty-host ' || true
  cp "$logs"/*.log "$out"/ 2>/dev/null || true
}
trap finish EXIT

# this run's repo, since an earlier run on the same machine logged the same line for its own
ready="webview: opened $repo, 1 changed file"
for _ in $(seq 60); do
  if grep -qF -- "$ready" "$logs"/*.log 2>/dev/null || ! kill -0 "$app" 2>/dev/null; then break; fi
  sleep 1
done
grep -qF -- "$ready" "$logs"/*.log 2>/dev/null || fail "the app did not log that it opened the repo within 60s"
sleep 2
if [ "$os" = Darwin ]; then screencapture -x "$out/window.png" || true; fi
kill -0 "$app" 2>/dev/null || fail "the app exited after opening the repo"
if grep -q ' ERROR ' "$logs"/*.log; then fail "the app logged errors"; fi
echo "smoke: the app opened the scratch repo and logged no errors"
