#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHECK_COVERAGE="${SCRIPT_DIR}/check-release-please-workspace-coverage.sh"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEST_ROOT"' EXIT

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

assert_contains() {
  local text=$1 expected=$2
  grep -Fq -- "$expected" <<<"$text" ||
    fail "expected output to contain: ${expected}"
}

expect_success() {
  local repo=$1 output

  if ! output=$(cd "$repo" && "$CHECK_COVERAGE" 2>&1); then
    echo "$output" >&2
    fail "expected workspace coverage check to succeed"
  fi
  assert_contains "$output" "release please workspace coverage: ok"
}

expect_failure() {
  local repo=$1 expected=$2 output

  if output=$(cd "$repo" && "$CHECK_COVERAGE" 2>&1); then
    fail "expected workspace coverage check to fail"
  fi
  assert_contains "$output" "$expected"
}

write_json() {
  local target=$1 filter=$2 next

  next="${target}.next"

  jq -c "$filter" "$target" >"$next"
  mv "$next" "$target"
}

setup_repo() {
  local name=$1
  REPO="${TEST_ROOT}/${name}"
  mkdir -p \
    "${REPO}/.github" \
    "${REPO}/native/helper/src" \
    "${REPO}/native/runner/src" \
    "${REPO}/native/guest-control-tests/src" \
    "${REPO}/turbo/apps/app/src" \
    "${REPO}/turbo/packages/tool" \
    "${REPO}/turbo/packages/ui/src"

  printf '%s\n' \
    'packages:' \
    '  - apps/*' \
    '  - packages/*' \
    >"${REPO}/turbo/pnpm-workspace.yaml"
  printf '%s\n' \
    '{"name":"app","version":"1.0.0","dependencies":{"ui":"workspace:*"}}' \
    >"${REPO}/turbo/apps/app/package.json"
  printf '%s\n' '{"name":"tool","private":true,"version":"0.0.0"}' \
    >"${REPO}/turbo/packages/tool/package.json"
  printf '%s\n' '{"name":"ui","private":true,"version":"0.0.0"}' \
    >"${REPO}/turbo/packages/ui/package.json"
  printf 'app source\n' >"${REPO}/turbo/apps/app/src/index.ts"
  printf 'ui source\n' >"${REPO}/turbo/packages/ui/src/index.ts"

  printf '%s\n' \
    '[workspace]' \
    'members = ["helper", "runner", "guest-control-tests"]' \
    'resolver = "2"' \
    >"${REPO}/native/Cargo.toml"
  printf '%s\n' \
    '[package]' \
    'name = "helper"' \
    'version = "1.0.0"' \
    'edition = "2024"' \
    >"${REPO}/native/helper/Cargo.toml"
  printf '%s\n' \
    '[package]' \
    'name = "runner"' \
    'version = "1.0.0"' \
    'edition = "2024"' \
    '' \
    '[dependencies]' \
    'helper = { path = "../helper" }' \
    >"${REPO}/native/runner/Cargo.toml"
  printf '%s\n' \
    '[package]' \
    'name = "guest-control-tests"' \
    'version = "1.0.0"' \
    'edition = "2024"' \
    '' \
    '[dependencies]' \
    'helper = { path = "../helper" }' \
    >"${REPO}/native/guest-control-tests/Cargo.toml"
  printf 'helper source\n' >"${REPO}/native/helper/src/lib.rs"
  printf 'runner source\n' >"${REPO}/native/runner/src/lib.rs"
  printf 'test source\n' >"${REPO}/native/guest-control-tests/src/lib.rs"
  cargo generate-lockfile --quiet --manifest-path "${REPO}/native/Cargo.toml"

  printf '%s\n' \
    '{"packages":{"native/helper":{"release-type":"rust"},"native/runner":{"release-type":"rust"},"turbo/apps/app":{"release-type":"node"},"turbo/packages/ui":{"release-type":"node","skip-changelog":true}},"plugins":[{"type":"node-workspace","alwaysLinkLocal":true},{"type":"cargo-workspace","cargoWorkspacePath":"native"}]}' \
    >"${REPO}/release-please-config.json"
  printf '%s\n' \
    '{"native/helper":"1.0.0","native/runner":"1.0.0","turbo/apps/app":"1.0.0","turbo/packages/ui":"0.0.0"}' \
    >"${REPO}/.release-please-manifest.json"
  printf '%s\n' \
    '{"native/guest-control-tests":"Integration-test harness","turbo/packages/tool":"Development tool"}' \
    >"${REPO}/.github/release-please-workspace-exclusions.json"

  git -C "$REPO" init -q -b main
  git -C "$REPO" config user.email test@example.com
  git -C "$REPO" config user.name Test
  git -C "$REPO" add --all
  git -C "$REPO" commit -qm "baseline"
}

setup_repo "valid-classification"
expect_success "$REPO"

setup_repo "unclassified-node-package"
mkdir -p "${REPO}/turbo/packages/new"
printf '%s\n' '{"name":"new","private":true,"version":"0.0.0"}' \
  >"${REPO}/turbo/packages/new/package.json"
expect_failure "$REPO" \
  "unclassified workspace packages: turbo/packages/new"

setup_repo "unclassified-rust-package"
mkdir -p "${REPO}/native/new/src"
printf '%s\n' \
  '[package]' \
  'name = "new"' \
  'version = "1.0.0"' \
  'edition = "2024"' \
  >"${REPO}/native/new/Cargo.toml"
printf 'new source\n' >"${REPO}/native/new/src/lib.rs"
sed -i 's/"guest-control-tests"/"guest-control-tests", "new"/' "${REPO}/native/Cargo.toml"
cargo generate-lockfile --quiet --manifest-path "${REPO}/native/Cargo.toml"
expect_failure "$REPO" "unclassified workspace packages: native/new"

setup_repo "stale-exclusion"
write_json \
  "${REPO}/.github/release-please-workspace-exclusions.json" \
  '. + {"turbo/packages/missing":"Missing package"}'
expect_failure "$REPO" \
  "workspace exclusions reference non-workspace packages: turbo/packages/missing"

setup_repo "overlapping-exclusion"
write_json \
  "${REPO}/.github/release-please-workspace-exclusions.json" \
  '. + {"turbo/packages/ui":"Runtime package"}'
expect_failure "$REPO" \
  "workspace packages cannot be both managed and excluded: turbo/packages/ui"

setup_repo "empty-exclusion-reason"
write_json \
  "${REPO}/.github/release-please-workspace-exclusions.json" \
  '.["turbo/packages/tool"] = ""'
expect_failure "$REPO" \
  "workspace exclusions must map package paths to non-empty reasons"

setup_repo "configured-non-workspace-package"
write_json \
  "${REPO}/release-please-config.json" \
  '.packages["turbo/packages/missing"] = {"release-type":"node"}'
write_json \
  "${REPO}/.release-please-manifest.json" \
  '.["turbo/packages/missing"] = "1.0.0"'
expect_failure "$REPO" \
  "configured Node packages are not pnpm workspace packages: turbo/packages/missing"

setup_repo "manifest-mismatch"
write_json \
  "${REPO}/.release-please-manifest.json" \
  'del(.["turbo/packages/ui"])'
expect_failure "$REPO" \
  "Release Please manifest is missing configured packages: turbo/packages/ui"

setup_repo "excluded-package-in-manifest"
write_json \
  "${REPO}/.release-please-manifest.json" \
  '.["native/guest-control-tests"] = "1.0.1"'
expect_failure "$REPO" \
  "Release Please manifest contains unconfigured packages: native/guest-control-tests"

echo "check-release-please-workspace-coverage-test: ok"

setup_repo "standalone-ios"
mkdir -p "$REPO/ios/Config"
printf '0.1.0\n' > "$REPO/ios/version.txt"
printf 'MARKETING_VERSION = 0.1.0 // x-release-please-version\n' > "$REPO/ios/Config/Shared.xcconfig"
write_json "$REPO/release-please-config.json" '.packages.ios = {"release-type":"simple","component":"ios"}'
write_json "$REPO/.release-please-manifest.json" '.ios = "0.1.0"'
expect_success "$REPO"
printf '0.1.1\n' > "$REPO/ios/version.txt"
expect_failure "$REPO" "iOS manifest, version.txt, and MARKETING_VERSION must agree"
