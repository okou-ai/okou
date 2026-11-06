#!/usr/bin/env bash
# Install the pinned macOS release; stdout is only the verified binary path.
# --path-only never downloads. Requires curl, shasum and unzip for installation.
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ios_root=$(cd "$script_dir/.." && pwd)
path_only=false
case "${1:-}" in
  '') ;;
  --path-only) path_only=true ;;
  *) echo 'usage: install-swiftlint.sh [--path-only]' >&2; exit 2 ;;
esac
if [[ $# -gt 1 ]]; then
  echo 'usage: install-swiftlint.sh [--path-only]' >&2
  exit 2
fi

version=$(sed -n 's/^version=//p' "$ios_root/.swiftlint-version")
checksum=$(sed -n 's/^sha256=//p' "$ios_root/.swiftlint-version")
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ || ! "$checksum" =~ ^[a-f0-9]{64}$ ]]; then
  echo 'Invalid ios/.swiftlint-version: version and SHA-256 are required.' >&2
  exit 1
fi
install_dir="$ios_root/.tools/swiftlint/$version"
binary="$install_dir/swiftlint"
if [[ -x "$binary" ]]; then
  if [[ "$("$binary" --version)" != "$version" ]]; then
    echo "Cached SwiftLint does not match $version; remove $install_dir and reinstall." >&2
    exit 1
  fi
  printf '%s\n' "$binary"
  exit 0
fi
if [[ "$path_only" == true ]]; then
  echo 'SwiftLint is not installed. Run bash ios/scripts/install-swiftlint.sh.' >&2
  exit 1
fi
if [[ "$(uname -s)" != Darwin ]]; then
  echo 'This installer supports macOS. On Linux, use the pinned CI image in ios.yml.' >&2
  exit 1
fi

mkdir -p "$install_dir"
download_dir=$(mktemp -d "$install_dir/.download.XXXXXX")
trap 'rm -rf "$download_dir"' EXIT
echo "Installing SwiftLint $version..." >&2
curl --proto '=https' --tlsv1.2 --fail --location --silent --show-error \
  --retry 2 --connect-timeout 15 --max-time 120 \
  --output "$download_dir/swiftlint.zip" \
  "https://github.com/realm/SwiftLint/releases/download/$version/portable_swiftlint.zip"
actual=$(shasum -a 256 "$download_dir/swiftlint.zip")
if [[ "${actual%% *}" != "$checksum" ]]; then
  echo "SwiftLint $version checksum mismatch; refusing to install." >&2
  exit 1
fi
unzip -q "$download_dir/swiftlint.zip" -d "$download_dir/unpacked"
chmod +x "$download_dir/unpacked/swiftlint"
if [[ "$("$download_dir/unpacked/swiftlint" --version)" != "$version" ]]; then
  echo "Downloaded SwiftLint does not match $version." >&2
  exit 1
fi
cp "$download_dir/unpacked/LICENSE" "$install_dir/LICENSE"
# The temporary directory shares the destination filesystem: publish atomically.
mv -f "$download_dir/unpacked/swiftlint" "$binary"
printf '%s\n' "$binary"
