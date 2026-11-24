#!/usr/bin/env bash
# Prepare the publishing payload while the isolated smoke emulator boots.
set -euo pipefail
umask 077
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
export ANDROID_HOME=${ANDROID_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/android-sdk}
cd "$root"
version=$(cat version.txt)
mkdir -p build/reports/release
artifacts=$(mktemp -d "$root/build/reports/release/run.XXXXXX")
exec python3 scripts/release-smoke.py "$artifacts/tested-app.apk" "$artifacts" "$version" \
  bash scripts/prepare-release-smoke-apk.sh "$version" "$artifacts"
