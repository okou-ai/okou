#!/usr/bin/env bash
set -euo pipefail

SOURCE_REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PASS_GATES="${SOURCE_REPO_ROOT}/.github/scripts/release/pass-release-pr-ci-gates.sh"
CHECK_COVERAGE="${SOURCE_REPO_ROOT}/.github/scripts/checks/check-release-please-workspace-coverage.sh"
CHECK_CYCLES="${SOURCE_REPO_ROOT}/.github/scripts/checks/check-rust-workspace-cycles.py"
CHECK_ACTION_PINS="${SOURCE_REPO_ROOT}/.github/scripts/checks/check-action-pins.py"
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
  "${SEED}/.github/scripts/checks" \
  "${SEED}/.github/workflows" \
  "${SEED}/ios/scripts" \
  "${SEED}/ios/Config" \
  "${SEED}/native/helper/src" \
  "${SEED}/native/guest-control-tests/src" \
  "${SEED}/turbo/apps/app/src" \
  "${SEED}/turbo/packages/tool"
cp "$CHECK_COVERAGE" "${SEED}/.github/scripts/checks/check-release-please-workspace-coverage.sh"
cp "$CHECK_CYCLES" "${SEED}/.github/scripts/checks/check-rust-workspace-cycles.py"
cp "$CHECK_ACTION_PINS" "${SEED}/.github/scripts/checks/check-action-pins.py"
cp "${SOURCE_REPO_ROOT}/ios/scripts/archive-promotion.py" "${SEED}/ios/scripts/archive-promotion.py"
printf 'let value = 1\n' >"${SEED}/ios/App.swift"
printf '1.0.0\n' >"${SEED}/ios/version.txt"
printf 'Prior releases\n' >"${SEED}/ios/CHANGELOG.md"
printf 'MARKETING_VERSION = 1.0.0 // x-release-please-version\n' >"${SEED}/ios/Config/Shared.xcconfig"
cat > "${SEED}/.github/workflows/pins.yml" <<'YAML'
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: echo fixture
YAML
cp "${SEED}/.github/workflows/pins.yml" "${SEED}/.github/workflows/ios.yml"
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
  '{"packages":{"ios":{"release-type":"simple"},"native/helper":{"release-type":"rust"},"turbo/apps/app":{"release-type":"node"}},"plugins":[{"type":"cargo-workspace","cargoWorkspacePath":"native"}]}' \
  >"${SEED}/release-please-config.json"
printf '%s\n' \
  '{"ios":"1.0.0","native/helper":"1.0.0","turbo/apps/app":"1.0.0"}' \
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

git -C "$SEED" switch -q -c release-invalid-cycle release-valid
printf '\n[dev-dependencies]\nguest-control-tests = { path = "../guest-control-tests" }\n' \
  >>"${SEED}/native/helper/Cargo.toml"
cargo generate-lockfile --quiet --manifest-path "${SEED}/native/Cargo.toml"
git -C "$SEED" add --all
git -C "$SEED" commit -qm "chore: release invalid cycle"
INVALID_CYCLE_HEAD=$(git -C "$SEED" rev-parse HEAD)
git -C "$SEED" push -q origin release-invalid-cycle

git -C "$SEED" switch -q -c release-invalid-pins release-valid
cat > "${SEED}/.github/workflows/pins.yml" <<'YAML'
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@0000000000000000000000000000000000000000
YAML
# The release head cannot approve its own bad references with a replaced checker.
printf '%s\n' 'print("untrusted release-head checker")' \
  >"${SEED}/.github/scripts/checks/check-action-pins.py"
git -C "$SEED" add --all
git -C "$SEED" commit -qm "chore: release invalid action pins"
INVALID_PINS_HEAD=$(git -C "$SEED" rev-parse HEAD)
git -C "$SEED" push -q origin release-invalid-pins

git clone -q "$REMOTE" "$CALLER"

cat >"${FAKE_BIN}/gh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

case "${1:-} ${2:-}" in
  "pr view")
    head=$MOCK_PR_HEAD
    if [ "${3:-}" = 42 ]; then head=${MOCK_LIVE_HEAD:-$head}; fi
    printf '{"number":42,"headRefOid":"%s","headRefName":"release-valid","baseRefOid":"%s","baseRefName":"main"}\n' "$head" "$MOCK_MAIN_HEAD"
    ;;
  "workflow run")
    printf '%s\n' "$*" >>"$MOCK_GH_LOG"
    if [ "${MOCK_DISPATCH_FAILURE:-false}" = true ]; then exit 1; fi
    ;;
  "api repos/okou-ai/okou/actions/workflows/ios.yml/runs"*)
    if [[ "$2" == *event=workflow_dispatch* ]]; then
      if [ "${MOCK_IOS_LOOKUP_FAILURE:-false}" = true ]; then exit 1; fi
      printf '[{"workflow_runs":%s}]\n' "${MOCK_EXISTING_IOS_RUNS:-[]}"
    elif [ "${MOCK_MAIN_IOS_PROOF:-false}" = true ] && [[ "$2" == *"head_sha=${MOCK_MAIN_HEAD}"* ]]; then
      printf '{"workflow_runs":[{"id":123,"run_attempt":1,"head_sha":"%s","event":"merge_group","path":".github/workflows/ios.yml","head_branch":"gh-readonly-queue/main/pr-1","conclusion":"success","html_url":"https://github.com/okou-ai/okou/actions/runs/123"}]}\n' "$MOCK_MAIN_HEAD"
    else
      printf '{"workflow_runs":[]}\n'
    fi
    ;;
  "api repos/okou-ai/okou/commits"*)
    printf '[{"sha":"%s"}]\n' "$MOCK_MAIN_HEAD"
    ;;
  "api repos/okou-ai/okou/actions/runs/123/attempts/1/jobs"*)
    printf '[{"jobs":[{"name":"build-test","conclusion":"success","steps":[{"name":"Build app and run isolated simulator tests","conclusion":"success"}]},{"name":"test-packages","conclusion":"success","steps":[{"name":"Run isolated Swift package tests","conclusion":"success"}]}]}]\n'
    ;;
  "api repos/okou-ai/okou/actions/runs/123/attempts/1")
    printf '{"head_sha":"%s","event":"merge_group","path":".github/workflows/ios.yml","head_branch":"gh-readonly-queue/main/pr-1"}\n' "$MOCK_MAIN_HEAD"
    ;;
  "api repos/okou-ai/okou/check-runs")
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
      GITHUB_REPOSITORY=okou-ai/okou \
      MOCK_GH_LOG="$GH_LOG" \
      MOCK_PR_HEAD="$head" \
      MOCK_MAIN_HEAD="$MAIN_HEAD" \
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
  "validation failed for exact head $INVALID_HEAD"
grep -Eq 'name=ci-gate-security .*conclusion=failure' "$GH_LOG" ||
  fail "the inconsistent release head should receive a failing security gate"
[ "$(git -C "$CALLER" rev-parse HEAD)" = "$MAIN_HEAD" ] ||
  fail "exact-head validation changed the caller checkout"
jq -e 'has("native/guest-control-tests") | not' \
  "${CALLER}/.release-please-manifest.json" >/dev/null ||
  fail "the caller main manifest should remain consistent"

: >"$GH_LOG"
if invalid_cycle_output=$(run_gates "$INVALID_CYCLE_HEAD" 2>&1); then
  fail "a development-dependency cycle on the exact release head should fail"
fi
assert_contains "$invalid_cycle_output" \
  "dependency cycle: guest-control-tests -> helper -> guest-control-tests"
assert_contains "$invalid_cycle_output" "validation failed for exact head $INVALID_CYCLE_HEAD"
grep -Eq "name=ci-gate-security .*head_sha=${INVALID_CYCLE_HEAD} .*conclusion=failure" "$GH_LOG" ||
  fail "the cyclic exact release head should receive a failing security gate"
if grep -Eq 'name=ci-gate-security .*conclusion=success' "$GH_LOG"; then
  fail "a cyclic release head received an unearned successful security gate"
fi
[ "$(git -C "$CALLER" rev-parse HEAD)" = "$MAIN_HEAD" ] ||
  fail "cycle validation changed the caller checkout"

python3 "$CHECK_ACTION_PINS" "$CALLER" >/dev/null
: >"$GH_LOG"
if invalid_pins_output=$(run_gates "$INVALID_PINS_HEAD" 2>&1); then
  fail "invalid action pins on the exact release head should fail"
fi
assert_contains "$invalid_pins_output" "actions/checkout must use"
assert_contains "$invalid_pins_output" "validation failed for exact head $INVALID_PINS_HEAD"
grep -Eq "name=ci-gate-security .*head_sha=${INVALID_PINS_HEAD} .*conclusion=failure" "$GH_LOG" ||
  fail "invalid action pins should receive a failing security gate on their exact head"
if grep -Eq 'name=ci-gate-security .*conclusion=success' "$GH_LOG"; then
  fail "invalid action pins received an unearned successful security gate"
fi
[ "$(git -C "$CALLER" rev-parse HEAD)" = "$MAIN_HEAD" ] ||
  fail "action pin validation changed the caller checkout"

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

for ios_input in ios/Okou/App/OkouApp.swift .github/workflows/ios.yml .github/scripts/checks/changed-base-ref.sh $'ios/line\nbreak.swift'; do
  git -C "$SEED" switch -q --detach "$VALID_HEAD"
  mkdir -p "${SEED}/$(dirname "$ios_input")"
  if [[ "$ios_input" == *.yml ]]; then
    cp "${SEED}/.github/workflows/pins.yml" "${SEED}/${ios_input}"
    printf '# fixture change\n' >>"${SEED}/${ios_input}"
  else
    printf 'fixture change\n' >"${SEED}/${ios_input}"
  fi
  git -C "$SEED" add --all
  git -C "$SEED" commit -qm "change native input"
  IOS_SOURCE_HEAD=$(git -C "$SEED" rev-parse HEAD)
  git -C "$SEED" push -q origin "HEAD:refs/heads/ios-source-${IOS_SOURCE_HEAD}"
  : >"$GH_LOG"
  ios_output=""
  ios_output=$(run_gates "$IOS_SOURCE_HEAD" 2>&1)
  grep -Fq "workflow run ios.yml --repo okou-ai/okou --ref release-valid" "$GH_LOG" ||
    fail "changed iOS inputs must dispatch real iOS validation"
  if grep -Eq 'name=ci-gate-ios .*conclusion=success' "$GH_LOG"; then
    fail "changed iOS inputs received an unearned successful iOS gate"
  fi
  assert_contains "$ios_output" "Dispatched iOS validation"
done

# A large diff must not turn an early iOS match into an unearned successful gate.
git -C "$SEED" switch -q --detach "$VALID_HEAD"
mkdir -p "${SEED}/docs"
for ((i = 0; i < 2000; i++)); do
  printf 'fixture\n' >"${SEED}/docs/release-changelog-fixture-${i}.md"
done
printf 'let changed = 2\n' >"${SEED}/ios/App.swift"
git -C "$SEED" add --all
git -C "$SEED" commit -qm "large release diff with native changes"
IOS_LARGE_HEAD=$(git -C "$SEED" rev-parse HEAD)
git -C "$SEED" push -q origin HEAD:refs/heads/ios-large
: >"$GH_LOG"
ios_output=""
ios_output=$(run_gates "$IOS_LARGE_HEAD" 2>&1)
grep -Fq "workflow run ios.yml --repo okou-ai/okou --ref release-valid" "$GH_LOG" ||
  fail "a large diff containing iOS changes must dispatch iOS validation"
if grep -Eq 'name=ci-gate-ios .*conclusion=success' "$GH_LOG"; then
  fail "a large diff containing iOS changes received an unearned successful iOS gate"
fi
assert_contains "$ios_output" "Dispatched iOS validation"

: >"$GH_LOG"
if MOCK_DISPATCH_FAILURE=true run_gates "$IOS_SOURCE_HEAD" >/dev/null 2>&1; then
  fail "a failed iOS workflow dispatch must fail the release refresh"
fi
if grep -Eq 'name=ci-gate-ios .*conclusion=success' "$GH_LOG"; then
  fail "dispatch failure cannot create a successful gate"
fi

# Exercise the actual release caller on a version-only Git head, not a path-name mock.
git -C "$SEED" switch -q --detach "$MAIN_HEAD"
printf '1.0.1\n' >"${SEED}/ios/version.txt"
printf 'MARKETING_VERSION = 1.0.1 // x-release-please-version\n' >"${SEED}/ios/Config/Shared.xcconfig"
printf 'Release notes\n' >"${SEED}/ios/CHANGELOG.md"
jq '.["ios"] = "1.0.1"' "${SEED}/.release-please-manifest.json" >"${SEED}/manifest.next"
mv "${SEED}/manifest.next" "${SEED}/.release-please-manifest.json"
git -C "$SEED" add --all
git -C "$SEED" commit -qm "release ios metadata"
IOS_METADATA_HEAD=$(git -C "$SEED" rev-parse HEAD)
git -C "$SEED" push -q origin HEAD:refs/heads/ios-metadata
: >"$GH_LOG"
metadata_output=$(MOCK_MAIN_IOS_PROOF=true run_gates "$IOS_METADATA_HEAD" 2>&1) || {
  echo "$metadata_output" >&2
  fail "verified release metadata should retain the native fast path"
}
grep -Eq 'name=ci-gate-ios .*conclusion=success' "$GH_LOG" || fail "verified metadata should reuse main tests"
assert_contains "$(cat "$GH_LOG")" "Release metadata verified against main tests"
if grep -Fq 'workflow run' "$GH_LOG"; then fail "verified metadata dispatched native validation"; fi

: >"$GH_LOG"
run_gates "$IOS_METADATA_HEAD" >/dev/null 2>&1
grep -Fq 'workflow run ios.yml' "$GH_LOG" || fail "missing main evidence must retain native validation"

for state in in_progress queued success failure cancelled action_required; do
  status=completed
  conclusion=$state
  if [ "$state" = in_progress ] || [ "$state" = queued ]; then status=$state; conclusion=null; fi
  runs=$(jq -nc --arg head "$IOS_METADATA_HEAD" --arg status "$status" --arg conclusion "$conclusion" \
    '[{head_sha:$head,head_branch:"release-valid",status:$status,conclusion:(if $conclusion == "null" then null else $conclusion end),created_at:"2026-11-04T00:00:00Z",html_url:"https://github.com/okou-ai/okou/actions/runs/456"}]')
  : >"$GH_LOG"
  if MOCK_MAIN_IOS_PROOF=true MOCK_EXISTING_IOS_RUNS="$runs" run_gates "$IOS_METADATA_HEAD" >/dev/null 2>&1; then
    case "$state" in failure | cancelled | action_required) fail "nonpassing existing validation was accepted" ;; esac
  else
    case "$state" in in_progress | queued | success) fail "existing validation should be retained" ;; esac
    grep -Eq 'name=ci-gate-ios .*conclusion=failure' "$GH_LOG" || fail "nonpassing validation must remain visible"
  fi
  if grep -Fq 'workflow run' "$GH_LOG"; then fail "same-SHA validation was dispatched again"; fi
  if grep -Eq 'name=ci-gate-ios .*conclusion=success' "$GH_LOG"; then fail "existing validation was replaced with an unearned pass"; fi
done

: >"$GH_LOG"
runs=$(jq -nc --arg head "$IOS_METADATA_HEAD" '[
  {id:456,head_sha:$head,head_branch:"release-valid",status:"completed",conclusion:"failure",created_at:"2026-11-04T00:00:00Z",html_url:"https://github.com/okou-ai/okou/actions/runs/456"},
  {id:455,head_sha:$head,head_branch:"release-valid",status:"completed",conclusion:"success",created_at:"2026-11-04T00:00:00Z",html_url:"https://github.com/okou-ai/okou/actions/runs/455"}
]')
if MOCK_EXISTING_IOS_RUNS="$runs" MOCK_MAIN_IOS_PROOF=true run_gates "$IOS_METADATA_HEAD" >/dev/null 2>&1; then
  fail "an older success must not conceal newer failed validation"
fi
grep -Eq 'name=ci-gate-ios .*conclusion=failure' "$GH_LOG" || fail "latest validation failure was not retained"

: >"$GH_LOG"
MOCK_LIVE_HEAD="$VALID_HEAD" MOCK_MAIN_IOS_PROOF=true run_gates "$IOS_METADATA_HEAD" >/dev/null 2>&1
[ ! -s "$GH_LOG" ] || fail "a superseded head must not schedule validation or publish checks"
: >"$GH_LOG"
if MOCK_IOS_LOOKUP_FAILURE=true run_gates "$IOS_METADATA_HEAD" >/dev/null 2>&1; then fail "an API failure must not be treated as absent validation"; fi
[ ! -s "$GH_LOG" ] || fail "failed validation lookup produced an unearned check"

command -v yq >/dev/null || fail "yq is required"
security_json=$(yq -o=json '.' "$SECURITY_WORKFLOW")
for workflow in release-please.yml release-please-refresh.yml; do
  yq -o=json '.' "${SOURCE_REPO_ROOT}/.github/workflows/${workflow}" | jq -e '
    .jobs["refresh-release-pull-request"].concurrency |
    .group == "release-please-pr-validation" and ."cancel-in-progress" == false
  ' >/dev/null || fail "release callers must serialize validation scheduling"
done
jq -e '
  .jobs["release-workspace-coverage"] as $validation |
  .jobs["action-pins"] as $pins |
  .jobs["ci-gate-security"] as $gate |
  ($pins | has("if") | not) and
  ($pins | has("needs") | not) and
  $pins.permissions == {"contents": "read"} and
  any($pins.steps[];
    ((.uses // "") | startswith("actions/checkout@")) and
    .with.ref == "${{ github.event_name == '\''pull_request'\'' && github.event.pull_request.head.sha || github.sha }}"
  ) and
  any($pins.steps[];
    .run == "python3 .github/scripts/checks/check-action-pins.py ."
  ) and
  ($gate.needs | index("action-pins") != null) and
  $gate.steps[0].env.ACTION_PINS_RESULT == "${{ needs.action-pins.result }}" and
  $validation.needs == ["detect-release"] and
  ($validation.if | contains("needs.detect-release.outputs.skip == '\''true'\''")) and
  ($validation.if | contains("github.event_name != '\''push'\''")) and
  any($validation.steps[];
    ((.uses // "") | startswith("actions/checkout@")) and
    .with.ref == "${{ github.event_name == '\''pull_request'\'' && github.event.pull_request.head.sha || github.sha }}"
  ) and
  any($validation.steps[];
    .name == "Check Release Please workspace coverage" and
    .run == ".github/scripts/checks/check-release-please-workspace-coverage.sh"
  ) and
  ($gate.needs | index("release-workspace-coverage") != null) and
  $gate.steps[0].env.RELEASE_WORKSPACE_COVERAGE_RESULT ==
    "${{ needs.release-workspace-coverage.result }}" and
  ($gate.steps[0].run | contains("$EVENT_NAME")) and
  ($gate.steps[0].run | contains("$RELEASE_WORKSPACE_COVERAGE_RESULT"))
' <<<"$security_json" >/dev/null ||
  fail "Security must validate action pins and release workspace coverage before its fast path"

echo "pass-release-pr-ci-gates-test: ok"
