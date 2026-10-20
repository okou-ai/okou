#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
script="$repo_root/.github/scripts/artifacts/cli-build-input-digest.sh"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
fixture="$tmp_dir/repo"
mkdir -p "$fixture/turbo/apps/cli/src" "$fixture/turbo/packages/shared" \
  "$fixture/turbo/patches" "$fixture/.github/actions/build-runner-cli" \
  "$fixture/.github/scripts/artifacts" "$fixture/crates"
git -C "$fixture" init -q
git -C "$fixture" config user.name Fixture
git -C "$fixture" config user.email fixture@example.com
paths=(turbo/apps/cli/src/okou.ts turbo/packages/shared/index.ts turbo/patches/sdk.patch
  turbo/pnpm-lock.yaml turbo/apps/cli/tsup.config.ts .github/actions/build-runner-cli/action.yml
  .github/scripts/artifacts/build.sh .npmrc package.json)
for path in "${paths[@]}" crates/runner.py; do
  printf 'baseline\n' >"$fixture/$path"
done
git -C "$fixture" add .
git -C "$fixture" commit -qm baseline

digest() {
  (cd "$fixture" && bash "$script" "$(git rev-parse HEAD)")
}
baseline="$(digest)"
[[ "$baseline" =~ ^[0-9a-f]{64}$ ]]
printf 'runner-only edit\n' >>"$fixture/crates/runner.py"
git -C "$fixture" commit -qam runner-only
[[ "$(digest)" == "$baseline" ]] || { echo 'Runner-only edit invalidated CLI inputs' >&2; exit 1; }

previous="$baseline"
for path in "${paths[@]}"; do
  printf 'changed\n' >>"$fixture/$path"
  git -C "$fixture" commit -qam input-change
  current="$(digest)"
  [[ "$current" != "$previous" ]] || { echo "CLI input was omitted: $path" >&2; exit 1; }
  previous="$current"
done
[[ "$(DEFAULT_SENTRY_DSN=https://synthetic.example.invalid/1 digest)" != "$previous" ]]

reject_digest() {
  local revision="$1"
  if (cd "$fixture" && bash "$script" "$revision") >"$tmp_dir/output" 2>"$tmp_dir/error"; then
    echo 'Digest accepted an inconsistent checkout' >&2
    exit 1
  fi
  [[ ! -s "$tmp_dir/output" ]]
}
reject_digest aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
printf 'uncommitted\n' >>"$fixture/turbo/apps/cli/src/okou.ts"
reject_digest "$(git -C "$fixture" rev-parse HEAD)"
git -C "$fixture" add .
git -C "$fixture" commit -qm committed
printf 'untracked\n' >"$fixture/turbo/apps/cli/src/untracked.ts"
reject_digest "$(git -C "$fixture" rev-parse HEAD)"

echo 'cli-build-input-digest-test: ok'
