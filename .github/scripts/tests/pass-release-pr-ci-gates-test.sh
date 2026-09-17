#!/usr/bin/env bash
set -euo pipefail

SOURCE_REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PASS_GATES="${SOURCE_REPO_ROOT}/.github/scripts/pass-release-pr-ci-gates.sh"
CHECK_COVERAGE="${SOURCE_REPO_ROOT}/.github/scripts/check-release-please-workspace-coverage.sh"
SECURITY_WORKFLOW="${SOURCE_REPO_ROOT}/.github/workflows/security.yml"
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

REMOTE="${TEST_ROOT}/remote.git"
SEED="${TEST_ROOT}/seed"
CALLER="${TEST_ROOT}/caller"
FAKE_BIN="${TEST_ROOT}/bin"
GH_LOG="${TEST_ROOT}/gh.log"
mkdir -p "$FAKE_BIN"

git init -q --bare "$REMOTE"
git init -q -b main "$SEED"
git -C "$SEED" config user.email test@example.com
git -C "$SEED" config user.name Test
mkdir -p \
  "${SEED}/.github/scripts" \
  "${SEED}/native/helper/src" \
  "${SEED}/native/guest-control-tests/src" \
  "${SEED}/turbo/apps/app/src" \
  "${SEED}/turbo/packages/tool"
cp "$CHECK_COVERAGE" "${SEED}/.github/scripts/check-release-please-workspace-coverage.sh"
printf '%s\n' \
  '{"native/guest-control-tests":"Integration-test harness","turbo/packages/tool":"Development tool"}' \
  >"${SEED}/.github/release-please-workspace-exclusions.json"
printf '%s\n' \
  'packages:' \
  '  - apps/*' \
  '  - packages/*' \
  >"${SEED}/turbo/pnpm-workspace.yaml"
printf '%s\n' '{"name":"app","version":"1.0.0"}' \
  >"${SEED}/turbo/apps/app/package.json"
printf '%s\n' '{"name":"tool","private":true,"version":"0.0.0"}' \
  >"${SEED}/turbo/packages/tool/package.json"
printf 'app source\n' >"${SEED}/turbo/apps/app/src/index.ts"
printf '%s\n' \
  '[workspace]' \
  'members = ["helper", "guest-control-tests"]' \
  'resolver = "2"' \
  >"${SEED}/native/Cargo.toml"
printf '%s\n' \
  '[package]' \
  'name = "helper"' \
  'version = "1.0.0"' \
  'edition = "2021"' \
  >"${SEED}/native/helper/Cargo.toml"
printf '%s\n' \
  '[package]' \
  'name = "guest-control-tests"' \
  'version = "1.0.0"' \
  'edition = "2021"' \
  '' \
  '[dependencies]' \
  'helper = { path = "../helper" }' \
  >"${SEED}/native/guest-control-tests/Cargo.toml"
printf 'helper source\n' >"${SEED}/native/helper/src/lib.rs"
printf 'test source\n' >"${SEED}/native/guest-control-tests/src/lib.rs"
cargo generate-lockfile --quiet --manifest-path "${SEED}/native/Cargo.toml"
printf '%s\n' \
  '{"packages":{"native/helper":{"release-type":"rust"},"turbo/apps/app":{"release-type":"node"}},"plugins":[{"type":"cargo-workspace","cargoWorkspacePath":"native"}]}' \
  >"${SEED}/release-please-config.json"
printf '%s\n' \
  '{"native/helper":"1.0.0","turbo/apps/app":"1.0.0"}' \
  >"${SEED}/.release-please-manifest.json"

git -C "$SEED" add --all
git -C "$SEED" commit -qm "baseline"
MAIN_HEAD=$(git -C "$SEED" rev-parse HEAD)
git -C "$SEED" remote add origin "$REMOTE"
git -C "$SEED" push -q -u origin main
git --git-dir="$REMOTE" symbolic-ref HEAD refs/heads/main

git -C "$SEED" switch -q -c release-invalid main
jq -c '.["native/guest-control-tests"] = "1.0.1"' \
  "${SEED}/.release-please-manifest.json" \
  >"${SEED}/.release-please-manifest.next.json"
mv \
  "${SEED}/.release-please-manifest.next.json" \
  "${SEED}/.release-please-manifest.json"
sed -i 's/version = "1.0.0"/version = "1.0.1"/' \
  "${SEED}/native/guest-control-tests/Cargo.toml"
cargo generate-lockfile --quiet --manifest-path "${SEED}/native/Cargo.toml"
git -C "$SEED" add --all
git -C "$SEED" commit -qm "chore: release invalid"
INVALID_HEAD=$(git -C "$SEED" rev-parse HEAD)
git -C "$SEED" push -q origin release-invalid

git -C "$SEED" switch -q -c release-valid main
jq -c '.["native/helper"] = "1.0.1"' \
  "${SEED}/.release-please-manifest.json" \
  >"${SEED}/.release-please-manifest.next.json"
mv \
  "${SEED}/.release-please-manifest.next.json" \
  "${SEED}/.release-please-manifest.json"
sed -i 's/version = "1.0.0"/version = "1.0.1"/' \
  "${SEED}/native/helper/Cargo.toml"
cargo generate-lockfile --quiet --manifest-path "${SEED}/native/Cargo.toml"
git -C "$SEED" add --all
git -C "$SEED" commit -qm "chore: release valid"
VALID_HEAD=$(git -C "$SEED" rev-parse HEAD)
git -C "$SEED" push -q origin release-valid

git clone -q "$REMOTE" "$CALLER"

cat >"${FAKE_BIN}/gh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

case "${1:-} ${2:-}" in
  "pr view")
    printf '{"number":42,"headRefOid":"%s"}\n' "$MOCK_PR_HEAD"
    ;;
  "pr diff")
    printf '%s\n' .release-please-manifest.json native/helper/Cargo.toml native/Cargo.lock
    if [ -n "${MOCK_ADDITIONAL_CHANGED_FILE:-}" ]; then
      printf '%s\n' "$MOCK_ADDITIONAL_CHANGED_FILE"
    fi
    if [ -n "${MOCK_ADDITIONAL_CHANGED_FILES_PATH:-}" ]; then
      cat "$MOCK_ADDITIONAL_CHANGED_FILES_PATH"
    fi
    ;;
  "api repos/vm0-ai/vm0/check-runs")
    printf '%s\n' "$*" >>"$MOCK_GH_LOG"
    printf '{"id":1}\n'
    ;;
  *)
    echo "unexpected gh invocation: $*" >&2
    exit 1
    ;;
esac
SH
chmod +x "${FAKE_BIN}/gh"

run_gates() {
  local head=$1
  (
    cd "$CALLER"
    GH_TOKEN=test \
      GITHUB_REPOSITORY=vm0-ai/vm0 \
      MOCK_GH_LOG="$GH_LOG" \
      MOCK_PR_HEAD="$head" \
      PATH="${FAKE_BIN}:$PATH" \
      bash "$PASS_GATES"
  )
}

# The caller checkout is consistent and remains on main throughout both cases.
(cd "$CALLER" && "$CHECK_COVERAGE") >/dev/null
[ "$(git -C "$CALLER" rev-parse HEAD)" = "$MAIN_HEAD" ] ||
  fail "caller checkout is not on the consistent main head"

: >"$GH_LOG"
invalid_output=""
if invalid_output=$(run_gates "$INVALID_HEAD" 2>&1); then
  fail "an inconsistent exact release PR head should fail"
fi
assert_contains \
  "$invalid_output" \
  "Release Please manifest contains unconfigured packages: native/guest-control-tests"
assert_contains \
  "$invalid_output" \
  "workspace coverage failed for exact head $INVALID_HEAD"
grep -Eq 'name=ci-gate-security .*conclusion=failure' "$GH_LOG" ||
  fail "the inconsistent release head should receive a failing security gate"
[ "$(git -C "$CALLER" rev-parse HEAD)" = "$MAIN_HEAD" ] ||
  fail "exact-head validation changed the caller checkout"
jq -e 'has("native/guest-control-tests") | not' \
  "${CALLER}/.release-please-manifest.json" >/dev/null ||
  fail "the caller main manifest should remain consistent"

: >"$GH_LOG"
valid_output=$(run_gates "$VALID_HEAD" 2>&1) || {
  echo "$valid_output" >&2
  fail "a consistent exact release PR head should retain the fast path"
}
assert_contains \
  "$valid_output" \
  "workspace coverage passed for exact head $VALID_HEAD"
[ "$(wc -l <"$GH_LOG" | tr -d ' ')" = 4 ] ||
  fail "the valid fast path should create exactly four required gate checks"
for gate in ci-gate-turbo ci-gate-crates ci-gate-security ci-gate-ios; do
  grep -Eq "name=${gate} .*conclusion=success" "$GH_LOG" ||
    fail "the valid fast path should pass ${gate}"
done

for ios_input in ios/Okou/App/OkouApp.swift .github/workflows/ios.yml .github/scripts/changed-base-ref.sh; do
  : >"$GH_LOG"
  ios_output=""
  if ios_output=$(MOCK_ADDITIONAL_CHANGED_FILE="$ios_input" run_gates "$VALID_HEAD" 2>&1); then
    fail "a release PR that changes $ios_input must not skip iOS validation"
  fi
  grep -Eq 'name=ci-gate-ios .*conclusion=failure' "$GH_LOG" ||
    fail "changed iOS inputs must receive a failing iOS gate"
  if grep -Eq 'name=ci-gate-ios .*conclusion=success' "$GH_LOG"; then
    fail "changed iOS inputs received an unearned successful iOS gate"
  fi
  assert_contains "$ios_output" "cannot skip iOS validation"
done

# A large diff must not turn an early iOS match into an unearned successful gate.
long_changed_files_path="${TEST_ROOT}/long-changed-files.txt"
{
  printf '%s\n' ios/Okou/App/OkouApp.swift
  for ((i = 0; i < 2000; i++)); do
    printf 'docs/release-changelog-fixture-with-a-long-filename-to-exercise-large-changed-file-lists-%04d.md\n' "$i"
  done
} >"$long_changed_files_path"
: >"$GH_LOG"
ios_output=""
if ios_output=$(MOCK_ADDITIONAL_CHANGED_FILES_PATH="$long_changed_files_path" run_gates "$VALID_HEAD" 2>&1); then
  fail "a large release PR diff containing iOS changes must not skip iOS validation"
fi
grep -Eq 'name=ci-gate-ios .*conclusion=failure' "$GH_LOG" ||
  fail "a large diff containing iOS changes must receive a failing iOS gate"
if grep -Eq 'name=ci-gate-ios .*conclusion=success' "$GH_LOG"; then
  fail "a large diff containing iOS changes received an unearned successful iOS gate"
fi
assert_contains "$ios_output" "cannot skip iOS validation"

command -v yq >/dev/null || fail "yq is required"
security_json=$(yq -o=json '.' "$SECURITY_WORKFLOW")
jq -e '
  .jobs["release-workspace-coverage"] as $validation |
  .jobs["ci-gate-security"] as $gate |
  $validation.needs == ["detect-release"] and
  ($validation.if | contains("needs.detect-release.outputs.skip == '\''true'\''")) and
  ($validation.if | contains("github.event_name != '\''push'\''")) and
  any($validation.steps[];
    ((.uses // "") | startswith("actions/checkout@")) and
    .with.ref == "${{ github.event_name == '\''pull_request'\'' && github.event.pull_request.head.sha || github.sha }}"
  ) and
  any($validation.steps[];
    .name == "Check Release Please workspace coverage" and
    .run == ".github/scripts/check-release-please-workspace-coverage.sh"
  ) and
  ($gate.needs | index("release-workspace-coverage") != null) and
  $gate.steps[0].env.RELEASE_WORKSPACE_COVERAGE_RESULT ==
    "${{ needs.release-workspace-coverage.result }}" and
  ($gate.steps[0].run | contains("$EVENT_NAME")) and
  ($gate.steps[0].run | contains("$RELEASE_WORKSPACE_COVERAGE_RESULT"))
' <<<"$security_json" >/dev/null ||
  fail "Security must validate release PR and merge-group workspace coverage before its fast path"

echo "pass-release-pr-ci-gates-test: ok"
