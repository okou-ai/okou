#!/usr/bin/env bash
# Stable APK build identity: count every commit reachable from the checked-out source.
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
if [ "$(git -C "$root" rev-parse --is-shallow-repository)" != false ]; then
  echo 'Android versionCode requires complete Git history; fetch with --unshallow' >&2
  exit 1
fi
code=$(git -C "$root" rev-list --count HEAD)
if (( code < 1 || code > 2147483647 )); then
  echo 'Git commit count does not fit an Android versionCode' >&2
  exit 1
fi
echo "$code"
