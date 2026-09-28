#!/bin/sh
# Installs the latest CodeBär release:
#   curl -fsSL https://raw.githubusercontent.com/oleksbard/codebaer/main/install.sh | sh
# curl sets no quarantine flag, so Gatekeeper never checks the ad-hoc signed app.
set -eu

main() {
  base=https://github.com/oleksbard/codebaer/releases/latest/download
  releases=https://github.com/oleksbard/codebaer/releases
  case "$(uname -s)" in
    Darwin) macos ;;
    Linux) linux ;;
    *) fail "CodeBär is built for macOS and Linux only" ;;
  esac
}

macos() {
  asset=codebaer-macos-arm64.tar.gz
  # uname -m says x86_64 inside a Rosetta shell; the sysctl reports the hardware.
  [ "$(sysctl -n hw.optional.arm64 2>/dev/null)" = 1 ] || fail "CodeBär is built for Apple Silicon Macs only"
  if osascript -e 'application id "com.codebaer.app" is running' 2>/dev/null | grep -q true; then
    fail "CodeBär is running. Quit it and run this again"
  fi

  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  echo "Downloading the latest CodeBär release"
  fetch "$asset"
  fetch SHA256SUMS.txt
  (cd "$tmp" && grep "  $asset\$" SHA256SUMS.txt | shasum -a 256 -c -s -) ||
    fail "the download does not match its checksum, nothing was installed"

  tar -xzf "$tmp/$asset" -C "$tmp"
  set -- "$tmp"/*.app
  [ -d "$1" ] || fail "the download holds no app, nothing was installed"
  app=$(basename "$1")

  if [ -d "/Applications/$app" ] && [ -w /Applications ]; then dest=/Applications
  elif [ -d "$HOME/Applications/$app" ]; then dest="$HOME/Applications"
  elif [ -w /Applications ]; then dest=/Applications
  else dest="$HOME/Applications"; fi
  mkdir -p "$dest"

  new="$dest/.$app.new"
  old="$dest/.$app.old"
  rm -rf "$new" "$old" 2>/dev/null || fail "could not remove $new or $old left by an earlier run; delete them and retry"
  mv "$1" "$new"
  if [ -e "$dest/$app" ]; then mv "$dest/$app" "$old"; fi
  if ! mv "$new" "$dest/$app"; then
    if [ -e "$old" ]; then mv "$old" "$dest/$app"; fi
    fail "could not put the new app in place, the old one is unchanged"
  fi
  rm -rf "$old" || echo "Could not remove $old; delete it by hand"
  xattr -dr com.apple.quarantine "$dest/$app" 2>/dev/null || true
  # Registers the bundle id now, so `open -b com.codebaer.app` finds the app before its first launch.
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
    -f "$dest/$app" 2>/dev/null || true

  version=$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$dest/$app/Contents/Info.plist")
  echo "Installed CodeBär $version in $dest"
  for other in "/Applications/$app" "$HOME/Applications/$app"; do
    if [ "$other" != "$dest/$app" ] && [ -d "$other" ]; then
      echo "Another copy is still in $(dirname "$other"); remove it so Spotlight and the Dock open this one"
    fi
  done
}

# The Linux beta is a .deb or an .rpm, and the package manager that installs it asks for a password, which a script
# read from a pipe should not do: this one downloads and checks the package, and says what to run.
linux() {
  [ "$(uname -m)" = x86_64 ] || fail "the Linux beta is built for x86_64 only for now"
  # by the distro, not by which tools are installed: Fedora can have apt, and openSUSE dnf
  # shellcheck disable=SC1091
  like=$(. /etc/os-release 2>/dev/null && echo "${ID:-} ${ID_LIKE:-}")
  case " $like " in
    *" debian "* | *" ubuntu "*) asset=codebaer-linux-amd64.deb install="sudo apt install" ;;
    *" suse "* | *" opensuse "*) asset=codebaer-linux-x86_64.rpm install="sudo zypper install --allow-unsigned-rpm" ;;
    *" fedora "* | *" rhel "*) asset=codebaer-linux-x86_64.rpm install="sudo dnf install" ;;
    *) fail "the Linux beta has packages for Debian, Fedora and openSUSE and their relatives only: $releases" ;;
  esac

  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  echo "Downloading the latest CodeBär release"
  fetch "$asset" \
    "could not download $asset; the latest release may have gone out without the Linux beta: $releases"
  fetch SHA256SUMS.txt
  (cd "$tmp" && grep "  $asset\$" SHA256SUMS.txt | sha256sum -c --status -) ||
    fail "the download does not match its checksum, so it was not kept"

  dir="${XDG_CACHE_HOME:-$HOME/.cache}/codebaer"
  mkdir -p "$dir"
  mv "$tmp/$asset" "$dir/$asset"
  echo "Downloaded $dir/$asset. To install it, or update to it, run:"
  echo "  $install '$dir/$asset'"
}

# $2 says what went wrong, when that is more than a failed download
fetch() {
  curl -fsSL --proto '=https' -o "$tmp/$1" "$base/$1" ||
    fail "${2:-could not download $1 of the latest release from $releases}"
}

fail() {
  printf 'install.sh: %s\n' "$1" >&2
  exit 1
}

main "$@"
