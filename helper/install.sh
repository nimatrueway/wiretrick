#!/bin/sh
# Downloads the wiretrick-helper binary for this machine from GitHub releases,
# verifies its SHA-256, and runs `wiretrick-helper install <args>` (which
# copies itself to a per-user location and registers the native host).
#
#   curl -fsSL https://raw.githubusercontent.com/nimatrueway/wiretrick/master/helper/install.sh | sh -s -- --extension-id <id> --trust-ca
#
# WIRETRICK_HELPER_VERSION=v1.2.3 pins a release (default: latest);
# WIRETRICK_HELPER_BASE_URL overrides the download location (testing).
set -eu

REPO="nimatrueway/wiretrick"
VERSION="${WIRETRICK_HELPER_VERSION:-latest}"

if [ -t 2 ] && [ -z "${NO_COLOR:-}" ]; then
    red=$(printf '\033[1;31m') dim=$(printf '\033[2m') off=$(printf '\033[0m')
else
    red="" dim="" off=""
fi
say() { printf '%s%s%s\n' "$dim" "$*" "$off" >&2; }
die() { printf '%serror:%s %s\n' "$red" "$off" "$*" >&2; exit 1; }

case "$(uname -s)" in
    Linux) os="unknown-linux-gnu" ;;
    Darwin) os="apple-darwin" ;;
    MINGW* | MSYS* | CYGWIN*) die "on Windows use PowerShell: see https://raw.githubusercontent.com/nimatrueway/wiretrick/master/helper/install.ps1" ;;
    *) die "unsupported OS: $(uname -s)" ;;
esac
case "$(uname -m)" in
    x86_64 | amd64) arch="x86_64" ;;
    arm64 | aarch64) arch="aarch64" ;;
    *) die "unsupported CPU: $(uname -m)" ;;
esac
# Apple Silicon running a Rosetta shell still gets the native binary
if [ "$os" = "apple-darwin" ] && [ "$arch" = "x86_64" ] && [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = "1" ]; then
    arch="aarch64"
fi

if [ -n "${WIRETRICK_HELPER_BASE_URL:-}" ]; then
    base="$WIRETRICK_HELPER_BASE_URL"
elif [ "$VERSION" = "latest" ]; then
    base="https://github.com/$REPO/releases/latest/download"
else
    base="https://github.com/$REPO/releases/download/$VERSION"
fi
asset="wiretrick-helper-$arch-$os.tar.gz"

fetch() {
    if command -v curl >/dev/null 2>&1; then
        curl -fsSL --retry 2 -o "$2" "$1"
    elif command -v wget >/dev/null 2>&1; then
        wget -q -O "$2" "$1"
    else
        die "curl or wget is required"
    fi
}

tmp=$(mktemp -d 2>/dev/null || mktemp -d -t wiretrick-helper)
trap 'rm -rf "$tmp"' EXIT INT TERM

say "downloading $asset ($VERSION)…"
fetch "$base/$asset" "$tmp/$asset" || die "download failed: $base/$asset"

if fetch "$base/SHA256SUMS" "$tmp/SHA256SUMS" 2>/dev/null; then
    want=$(awk -v f="$asset" '$2 == f || $2 == "*" f { print $1 }' "$tmp/SHA256SUMS")
    if command -v sha256sum >/dev/null 2>&1; then
        got=$(sha256sum "$tmp/$asset" | awk '{ print $1 }')
    else
        got=$(shasum -a 256 "$tmp/$asset" | awk '{ print $1 }')
    fi
    [ -n "$want" ] || die "$asset is missing from SHA256SUMS"
    [ "$want" = "$got" ] || die "checksum mismatch for $asset (expected $want, got $got)"
    say "checksum ok"
else
    say "no SHA256SUMS in this release — skipping checksum"
fi

tar -xzf "$tmp/$asset" -C "$tmp"
chmod +x "$tmp/wiretrick-helper"
# stdin is this script when piped (`curl | sh`): give the helper the terminal
if [ ! -t 0 ] && (: </dev/tty) 2>/dev/null; then
    "$tmp/wiretrick-helper" install "$@" </dev/tty
else
    "$tmp/wiretrick-helper" install "$@"
fi
