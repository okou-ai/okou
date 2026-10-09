#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
script=${CHANGED_SCRIPT:-$repo_root/scripts/changed.sh}
test_dir=$(mktemp -d)
trap 'rm -rf "$test_dir"' EXIT
repo="$test_dir/repo"
mkdir -p "$repo/turbo/apps/web" "$repo/turbo/apps/unrelated" "$repo/turbo/packages/shared" "$repo/ios"

git -C "$repo" init -q
git -C "$repo" config user.email test@example.com
git -C "$repo" config user.name Test
cat >"$repo/turbo/package.json" <<'JSON'
{"name":"hash-test","private":true,"packageManager":"pnpm@10.15.0"}
JSON
cat >"$repo/turbo/pnpm-workspace.yaml" <<'YAML'
packages:
  - apps/*
  - packages/*
YAML
cat >"$repo/turbo/pnpm-lock.yaml" <<'YAML'
lockfileVersion: '9.0'
settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false
importers:
  .: {}
  apps/web:
    dependencies:
      shared:
        specifier: workspace:*
        version: link:../../packages/shared
  apps/unrelated: {}
  packages/shared: {}
YAML
cat >"$repo/turbo/turbo.json" <<'JSON'
{"globalEnv":["PATH"],"tasks":{"build":{"dependsOn":["^build"]}}}
JSON
cat >"$repo/turbo/apps/web/package.json" <<'JSON'
{"name":"web","scripts":{"build":"echo web"},"dependencies":{"shared":"workspace:*"}}
JSON
cat >"$repo/turbo/apps/unrelated/package.json" <<'JSON'
{"name":"unrelated","scripts":{"build":"echo unrelated"}}
JSON
cat >"$repo/turbo/packages/shared/package.json" <<'JSON'
{"name":"shared","scripts":{"build":"echo shared"}}
JSON
printf 'export const value = 1;\n' >"$repo/turbo/packages/shared/index.ts"
printf 'import { value } from "shared";\n' >"$repo/turbo/apps/web/index.ts"
printf '// iOS source\n' >"$repo/ios/App.swift"
git -C "$repo" add .
git -C "$repo" commit -qm base
base=$(git -C "$repo" rev-parse HEAD)
npm_cache="$test_dir/npm-cache"
npm_offline=false

compare() {
  local revision=$1 expected=$2
  if ! (cd "$repo" && npm_config_cache="$npm_cache" npm_config_prefer_offline=true \
    npm_config_offline="$npm_offline" bash "$script" "$revision") \
    >"$test_dir/result.json" 2>"$test_dir/stderr"; then
    cat "$test_dir/stderr" >&2
    exit 1
  fi
  jq -e --argjson expected "$expected" '. == $expected' "$test_dir/result.json" >/dev/null || {
    echo "Unexpected package changes: $(cat "$test_dir/result.json")" >&2
    exit 1
  }
}

# Use the actual Turbo CLI: npx injects directory-specific PATH entries even
# when both worktrees contain exactly the same build inputs.
compare "$base" '{"shared":false,"web":false,"unrelated":false}'

# A restored install and registry cache must work from a fresh cache location
# without npm networking, while both worktrees retain the same inherited PATH.
restored_cache="$test_dir/restored-npm-cache"
mkdir -p "$restored_cache"
cp -a "$npm_cache/_cacache" "$npm_cache/_npx" "$restored_cache/"
npm_cache="$restored_cache"
npm_offline=true
compare "$base" '{"shared":false,"web":false,"unrelated":false}'
printf '// iOS-only edit\n' >>"$repo/ios/App.swift"
git -C "$repo" commit -qam ios-only
compare "$base" '{"shared":false,"web":false,"unrelated":false}'

# A shared source change must still invalidate its consuming app.
printf 'export const next = 2;\n' >>"$repo/turbo/packages/shared/index.ts"
git -C "$repo" commit -qam shared-source
compare "$base" '{"shared":true,"web":true,"unrelated":false}'
shared=$(git -C "$repo" rev-parse HEAD)
printf 'console.log(value);\n' >>"$repo/turbo/apps/web/index.ts"
git -C "$repo" commit -qam web-source
compare "$shared" '{"shared":false,"web":true,"unrelated":false}'

# An unavailable required tool is still a failure, never an all-unchanged result.
status=0
(cd "$repo" && npm_config_cache="$test_dir/empty-npm-cache" \
  npm_config_offline=true bash "$script" "$base") \
  >"$test_dir/result.json" 2>"$test_dir/stderr" || status=$?
[[ "$status" != 0 && ! -s "$test_dir/result.json" ]] || {
  echo 'An empty offline cache must fail without a package-change result' >&2
  exit 1
}
grep -q 'Turbo executable resolution failed' "$test_dir/stderr"
[[ $(git -C "$repo" worktree list --porcelain | grep -c '^worktree ') == 1 ]]

echo 'changed-environment-test: ok'
