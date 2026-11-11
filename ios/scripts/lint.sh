#!/usr/bin/env bash
# Lint the complete owned Swift tree from any directory. No download or fixes.
# SWIFTLINT_BIN optionally selects a built binary; its rule receipt must match.
# GitHub Actions receives inline annotations. Configuration warnings also fail.
set -euo pipefail

if [[ $# -ne 0 ]]; then
  echo 'usage: lint.sh' >&2
  exit 2
fi
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ios_root=$(cd "$script_dir/.." && pwd)
version=$(sed -n 's/^version=//p' "$ios_root/.swiftlint-version")
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo 'Invalid version in ios/.swiftlint-version.' >&2
  exit 1
fi
if [[ -n "${SWIFTLINT_BIN:-}" ]]; then
  binary=$SWIFTLINT_BIN
else
  binary=$(bash "$script_dir/install-swiftlint.sh" --path-only)
fi
python3 "$ios_root/Tools/SwiftLint/build.py" --verify "$binary"
reporter=xcode
if [[ "${GITHUB_ACTIONS:-}" == true ]]; then
  reporter=github-actions-logging
fi
cd "$ios_root"
if [[ ! -f .swiftlint.yml ]]; then
  echo 'Missing ios/.swiftlint.yml.' >&2
  exit 1
fi
# The selected rules use SwiftSyntax; no compiler service or App build is needed.
# Discover the root config here: --config disables directory-specific overrides.
diagnostics=$(mktemp)
trap 'rm -f "$diagnostics"' EXIT
result=0
"$binary" lint --strict --no-cache --disable-sourcekit --reporter "$reporter" \
  2> "$diagnostics" || result=$?
cat "$diagnostics" >&2
if [[ "$result" -ne 0 ]]; then
  exit "$result"
fi
# --strict covers findings, but SwiftLint exits 0 for unknown rule identifiers.
if grep -q '^warning:' "$diagnostics"; then
  echo 'SwiftLint configuration warnings must be resolved.' >&2
  exit 1
fi
