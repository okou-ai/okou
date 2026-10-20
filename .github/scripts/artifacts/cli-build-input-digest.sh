#!/usr/bin/env bash
set -euo pipefail

# Run in a clean checkout. Hash conservative Git trees rather than maintaining
# a second dependency graph; Runner-only changes can reuse identical CLI inputs.
if [[ "$#" -ne 1 || ! "$1" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Usage: $0 <checked-out-source-sha>" >&2
  exit 1
fi
test "$(git rev-parse HEAD)" = "$1"
git cat-file -e HEAD:turbo
input_paths=(turbo .github/actions/build-runner-cli .github/scripts/artifacts
  .npmrc .pnpmfile.cjs package.json pnpm-lock.yaml pnpm-workspace.yaml)
git diff --quiet HEAD -- "${input_paths[@]}"
test -z "$(git ls-files --others --exclude-standard -- "${input_paths[@]}")"
source_inputs="$(git ls-tree HEAD -- "${input_paths[@]}")"
node_version="$(node --version)"
npm_version="$(npm --version)"
checkout_root="$(git rev-parse --show-toplevel)"
{
  printf '%s\0' 'runner-cli-build-v1' "$source_inputs" "$node_version" "$npm_version" \
    "$checkout_root" "${DEFAULT_SENTRY_DSN:-}"
} | sha256sum | cut -d ' ' -f 1
