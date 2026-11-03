#!/bin/sh
# Crocodile installer for macOS and Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/pwalda/crocodile/main/scripts/install.sh | sh
#
# Downloads the latest release from GitHub and installs it:
#   macOS  -> /Applications/Crocodile.app (or ~/Applications)
#   Linux  -> the .deb/.rpm through your package manager, or an AppImage
#             in ~/.local/bin when neither apt nor dnf/zypper is available.
#
# The command line tool instead (to ~/.local/bin/crocodile):
#
#   curl -fsSL https://raw.githubusercontent.com/pwalda/crocodile/main/scripts/install.sh | sh -s -- --cli
# Files fetched with curl are not quarantined, so macOS does not show the
# "unidentified developer" warning for builds without an Apple Developer ID.
set -eu

REPO="${CROC_REPO:-pwalda/crocodile}"
API="https://api.github.com/repos/$REPO/releases/latest"
WHAT="${CROC_INSTALL:-app}"
for a in "$@"; do
  case "$a" in
    --cli) WHAT=cli ;;
  esac
done

say() { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "$1 is required"; }
# Everything is fetched over https, and a redirect may not leave it either.
fetch() { curl --proto '=https' --proto-redir '=https' "$@"; }

# The release lists the SHA-512 (base64) of each installer in the update file the app's
# updater reads (latest*.yml). What does not match is deleted, and not installed.
hex_of_file() {
  if command -v sha512sum >/dev/null 2>&1; then sha512sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 512 "$1" | cut -d' ' -f1
  elif command -v openssl >/dev/null 2>&1; then openssl dgst -sha512 -r "$1" | cut -d' ' -f1
  else die "cannot check the download: none of sha512sum, shasum and openssl is installed"
  fi
}
hex_of_b64() {
  { printf '%s' "$1" | base64 --decode 2>/dev/null || printf '%s' "$1" | base64 -d; } |
    od -An -v -tx1 | tr -d ' \n'
}
# check FILE NAME EXPECTED: EXPECTED is the base64 SHA-512 the release lists for NAME.
check() {
  if [ -z "$3" ]; then rm -f "$1"; die "the release lists no checksum for $2"; fi
  if [ "$(hex_of_file "$1")" != "$(hex_of_b64 "$3")" ]; then
    rm -f "$1"
    die "$2 does not match the checksum the release lists for it"
  fi
}
# check_app FILE URL UPDATE-FILE: the update file sits beside the installer in the release.
check_app() {
  name=$(basename "$2")
  want=$(fetch -fsSL "${2%/*}/$3" | awk -v n="$name" '$1 == "-" && $2 == "url:" { hit = ($3 == n) } hit && $1 == "sha512:" { print $2; exit }')
  check "$1" "$name" "$want"
}
# check_cli FILE URL: the checksum is published beside the program (releases made before
# that was added have none, and are installed as before).
check_cli() {
  want=$(fetch -fsSL "$2.sha512" 2>/dev/null | tr -d ' \r\n' || true)
  if [ -z "$want" ]; then say "No checksum is published for $(basename "$2"); not checking it"; return 0; fi
  check "$1" "$(basename "$2")" "$want"
}

need curl
os=$(uname -s)
arch=$(uname -m)
case "$arch" in
  x86_64 | amd64) arch_re='(x64|x86_64|amd64)' ;;
  arm64 | aarch64) arch_re='(arm64|aarch64)' ;;
  *) die "unsupported CPU architecture: $arch" ;;
esac

say "Looking up the latest Crocodile release"
assets=$(fetch -fsSL "$API" | grep -o '"browser_download_url": *"[^"]*"' | sed 's/.*"\(https[^"]*\)"/\1/')
[ -n "$assets" ] || die "could not read the release list from GitHub"

pick() { printf '%s\n' "$assets" | grep -E -e "$1" | grep -v '\.blockmap$' | head -n 1; }
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

if [ "$WHAT" = cli ]; then
  case "$os" in
    Darwin) cli_os=macos ;;
    Linux) cli_os=linux ;;
    *) die "unsupported system: $os (on Windows use install.ps1)" ;;
  esac
  case "$arch" in
    x86_64 | amd64) cli_arch=x64 ;;
    *) cli_arch=arm64 ;;
  esac
  name="crocodile-cli-$cli_os-$cli_arch"
  url=$(pick "/$name\.tar\.gz$")
  [ -n "$url" ] || die "no command line build for $cli_os $cli_arch; with Node.js 22 or newer: npm install -g crocodile-cli"
  say "Downloading $(basename "$url")"
  fetch -fL --progress-bar "$url" -o "$tmp/cli.tar.gz"
  check_cli "$tmp/cli.tar.gz" "$url"
  tar -xzf "$tmp/cli.tar.gz" -C "$tmp"
  mkdir -p "$HOME/.local/bin"
  cp "$tmp/$name" "$HOME/.local/bin/crocodile"
  chmod 755 "$HOME/.local/bin/crocodile"
  say "Installed ~/.local/bin/crocodile"
  case ":$PATH:" in
    *":$HOME/.local/bin:"*) ;;
    *) say "Add ~/.local/bin to your PATH to run it as crocodile" ;;
  esac
  say "Done. Start with: crocodile help"
  exit 0
fi

case "$os" in
  Darwin)
    url=$(pick '-mac-(universal|'"${arch_re#(}"'\.zip$')
    [ -n "$url" ] || die "no macOS download found"
    say "Downloading $(basename "$url")"
    fetch -fL --progress-bar "$url" -o "$tmp/croc.zip"
    check_app "$tmp/croc.zip" "$url" latest-mac.yml
    dest=/Applications
    [ -w "$dest" ] || { dest="$HOME/Applications"; mkdir -p "$dest"; }
    rm -rf "$dest/Crocodile.app"
    ditto -x -k "$tmp/croc.zip" "$dest"
    say "Installed to $dest/Crocodile.app"
    open "$dest/Crocodile.app"
    ;;
  Linux)
    case "$arch" in
      arm64 | aarch64) update=latest-linux-arm64.yml ;;
      *) update=latest-linux.yml ;;
    esac
    if command -v apt-get >/dev/null 2>&1 && url=$(pick "$arch_re"'\.deb$') && [ -n "$url" ]; then
      say "Downloading $(basename "$url")"
      fetch -fL --progress-bar "$url" -o "$tmp/crocodile.deb"
      check_app "$tmp/crocodile.deb" "$url" "$update"
      say "Installing (you may be asked for your password)"
      sudo apt-get install -y "$tmp/crocodile.deb"
    elif { command -v dnf >/dev/null 2>&1 || command -v zypper >/dev/null 2>&1; } &&
      url=$(pick "$arch_re"'\.rpm$') && [ -n "$url" ]; then
      say "Downloading $(basename "$url")"
      fetch -fL --progress-bar "$url" -o "$tmp/crocodile.rpm"
      check_app "$tmp/crocodile.rpm" "$url" "$update"
      say "Installing (you may be asked for your password)"
      if command -v dnf >/dev/null 2>&1; then sudo dnf install -y "$tmp/crocodile.rpm"; else sudo zypper --non-interactive install --allow-unsigned-rpm "$tmp/crocodile.rpm"; fi
    else
      url=$(pick "$arch_re"'\.AppImage$')
      [ -n "$url" ] || die "no Linux download found for $arch"
      mkdir -p "$HOME/.local/bin" "$HOME/.local/share/applications"
      say "Downloading $(basename "$url")"
      fetch -fL --progress-bar "$url" -o "$HOME/.local/bin/Crocodile.AppImage"
      check_app "$HOME/.local/bin/Crocodile.AppImage" "$url" "$update"
      chmod +x "$HOME/.local/bin/Crocodile.AppImage"
      cat >"$HOME/.local/share/applications/crocodile.desktop" <<DESKTOP
[Desktop Entry]
Name=Crocodile
Comment=Peer-to-peer, end-to-end encrypted voice and text chat
Exec=$HOME/.local/bin/Crocodile.AppImage %U
Terminal=false
Type=Application
Categories=Network;Chat;InstantMessaging;
MimeType=x-scheme-handler/croc;
StartupWMClass=Crocodile
DESKTOP
      command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$HOME/.local/share/applications" || true
      say "Installed to ~/.local/bin/Crocodile.AppImage (AppImages need libfuse2)"
    fi
    say "Done. Open Crocodile from your applications menu."
    ;;
  *) die "unsupported system: $os (on Windows use install.ps1)" ;;
esac
