#!/usr/bin/env bash
# Starts the bundled app on a scratch repo. Fails unless the webview logs that it loaded the repo, the app is still
# running a moment later, and nothing logged an error. CI only: it runs on this user's real app data and logs, and
# kills every pty host when it is done.
set -euo pipefail

if [ -z "${CI:-}" ]; then
  echo "smoke.sh runs in CI only: here it would open a scratch repo in your CodeBär and end your terminal sessions" >&2
  exit 1
fi

apps=(src-tauri/target/release/bundle/macos/*.app)
exe="$PWD/${apps[0]}/Contents/MacOS/codebaer"
logs="$HOME/Library/Logs/com.codebaer.app"
out="${RUNNER_TEMP:?}/smoke"
mkdir -p "$out"

fail() {
  echo "::error::smoke: $1"
  cat "$logs"/*.log 2>/dev/null || cat "$out/app.out" 2>/dev/null || true
  exit 1
}

[ -x "$exe" ] || fail "no app bundle at $exe"

repo=$(mktemp -d)
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

ready='webview: opened .+, 1 changed file'
for _ in $(seq 60); do
  if grep -qE -- "$ready" "$logs"/*.log 2>/dev/null || ! kill -0 "$app" 2>/dev/null; then break; fi
  sleep 1
done
grep -qE -- "$ready" "$logs"/*.log 2>/dev/null || fail "the app did not log that it opened the repo within 60s"
sleep 2
screencapture -x "$out/window.png" || true
kill -0 "$app" 2>/dev/null || fail "the app exited after opening the repo"
if grep -q ' ERROR ' "$logs"/*.log; then fail "the app logged errors"; fi
echo "smoke: the app opened the scratch repo and logged no errors"
