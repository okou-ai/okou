#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHECK_COVERAGE="${SCRIPT_DIR}/check-release-please-workspace-coverage.sh"
CHECK_CYCLES="${SCRIPT_DIR}/check-rust-workspace-cycles.py"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEST_ROOT"' EXIT

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

assert_contains() {
  local text=$1 expected=$2
  if ! grep -Fq -- "$expected" <<<"$text"; then
    echo "$text" >&2
    fail "expected output to contain: ${expected}"
  fi
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
  LAST_OUTPUT=$output
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

# Cargo accepts the dev-cycle case; repository policy also includes normal and
# build declarations without needing to resolve or compile any dependencies.
for kind in normal dev build; do
  setup_repo "${kind}-dependency-cycle"
  section="${kind}-dependencies"
  if [ "$kind" = normal ]; then
    section=dependencies
  fi
  printf '\n[%s]\nrunner = { path = "../runner" }\n' "$section" \
    >>"${REPO}/native/helper/Cargo.toml"
  expect_failure "$REPO" "dependency cycle: helper -> runner -> helper"
  assert_contains "$LAST_OUTPUT" "helper -> runner: ${kind}-dependency (native/helper/Cargo.toml)"
  assert_contains "$LAST_OUTPUT" "runner -> helper: normal-dependency (native/runner/Cargo.toml)"
done

setup_repo "transitive-cycle-through-excluded-member"
sed -i '/^helper = /d' "${REPO}/native/guest-control-tests/Cargo.toml"
printf '\n[dev-dependencies]\nrunner = { path = "../runner" }\n' \
  >>"${REPO}/native/guest-control-tests/Cargo.toml"
printf '\n[dev-dependencies]\nguest-control-tests = { path = "../guest-control-tests" }\n' \
  >>"${REPO}/native/helper/Cargo.toml"
expect_failure "$REPO" \
  "dependency cycle: guest-control-tests -> runner -> helper -> guest-control-tests"
assert_contains "$LAST_OUTPUT" "guest-control-tests -> runner: dev-dependency (native/guest-control-tests/Cargo.toml)"

setup_repo "disconnected-self-cycle"
printf '\n[dev-dependencies]\nguest-control-tests = { path = "." }\n' \
  >>"${REPO}/native/guest-control-tests/Cargo.toml"
expect_failure "$REPO" "dependency cycle: guest-control-tests -> guest-control-tests"

for kind in normal dev build; do
  setup_repo "target-${kind}-dependency-cycle"
  section="${kind}-dependencies"
  if [ "$kind" = normal ]; then
    section=dependencies
  fi
  printf '\n[target.\x27cfg(windows)\x27.%s]\nrunner = { path = "../runner" }\n' "$section" \
    >>"${REPO}/native/helper/Cargo.toml"
  expect_failure "$REPO" "dependency cycle: helper -> runner -> helper"
  assert_contains "$LAST_OUTPUT" "helper -> runner: ${kind}-dependency, target=cfg(windows)"
done

setup_repo "mutually-exclusive-targets"
sed -i "s/\[dependencies\]/[target.'cfg(windows)'.dependencies]/" \
  "${REPO}/native/runner/Cargo.toml"
printf '\n[target.\x27cfg(unix)\x27.dev-dependencies]\nrunner = { path = "../runner" }\n' \
  >>"${REPO}/native/helper/Cargo.toml"
expect_failure "$REPO" "dependency cycle: helper -> runner -> helper"
assert_contains "$LAST_OUTPUT" "target=cfg(unix)"
assert_contains "$LAST_OUTPUT" "target=cfg(windows)"

setup_repo "inactive-optional-inherited-renamed-cycle"
printf '\n[workspace.dependencies]\ntransport = { package = "runner", path = "runner" }\n' \
  >>"${REPO}/native/Cargo.toml"
printf '\n[dependencies]\ntransport = { workspace = true, optional = true }\n' \
  >>"${REPO}/native/helper/Cargo.toml"
expect_failure "$REPO" "dependency cycle: helper -> runner -> helper"
assert_contains "$LAST_OUTPUT" "helper -> runner: normal-dependency, optional=true, rename=transport (native/helper/Cargo.toml)"

setup_repo "acyclic-optional-target-inherited-alias"
printf '\n[workspace.dependencies]\ncontracts = { package = "helper", path = "helper" }\n' \
  >>"${REPO}/native/Cargo.toml"
printf '\n[target.\x27cfg(windows)\x27.build-dependencies]\ncontracts = { workspace = true, optional = true }\n' \
  >>"${REPO}/native/runner/Cargo.toml"
expect_success "$REPO"

setup_repo "external-name-collision"
mkdir -p "${TEST_ROOT}/external-runner/src"
printf '[package]\nname = "runner"\nversion = "2.0.0"\nedition = "2024"\n' \
  >"${TEST_ROOT}/external-runner/Cargo.toml"
printf '\n' >"${TEST_ROOT}/external-runner/src/lib.rs"
printf '\n[dependencies]\nexternal-runner = { package = "runner", path = "%s" }\nregistry-runner = { package = "runner", version = "999.0" }\n' \
  "${TEST_ROOT}/external-runner" >>"${REPO}/native/helper/Cargo.toml"
# --no-deps does not fetch/resolve the unavailable registry version. Neither
# same-named external declaration is the workspace's local runner package.
expect_success "$REPO"

for metadata in '{}' '{"version":1,"packages":[],"workspace_members":[]}'; do
  if output=$(python3 "$CHECK_CYCLES" <<<"$metadata" 2>&1); then
    fail "expected incomplete Cargo metadata to fail"
  fi
  assert_contains "$output" "rust workspace cycles:"
done

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

setup_repo "standalone-desktop"
mkdir -p "$REPO/desktop"
printf '0.49.71\n' > "$REPO/desktop/version.txt"
write_json "$REPO/release-please-config.json" '.packages.desktop = {"release-type":"simple","component":"desktop"}'
write_json "$REPO/.release-please-manifest.json" '.desktop = "0.49.71"'
expect_success "$REPO"
printf '0.50.0\n' > "$REPO/desktop/version.txt"
expect_failure "$REPO" "Desktop manifest and version.txt must agree"
