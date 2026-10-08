#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
CHECKER="${SCRIPT_DIR}/action-pins-test.py"

python3 "$CHECKER" "$REPO_ROOT"
approved_reference() {
  python3 - "$CHECKER" "$1" <<'PY'
import runpy
import sys

approved = runpy.run_path(sys.argv[1])["APPROVED_ACTIONS"]
action = sys.argv[2]
print(f"{action}@{approved[action]}")
PY
}
approved_checkout="$(approved_reference actions/checkout)"
approved_codeql="$(approved_reference github/codeql-action/init)"

TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEST_ROOT"' EXIT
mkdir -p "${TEST_ROOT}/.github/workflows" "${TEST_ROOT}/.github/actions/nested/example"
WORKFLOW="${TEST_ROOT}/.github/workflows/main.yaml"
ACTION="${TEST_ROOT}/.github/actions/nested/example/action.yaml"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

expect_failure() {
  local expected=$1 output
  if output="$(python3 "$CHECKER" "$TEST_ROOT" 2>&1)"; then
    fail "expected action pin validation to fail"
  fi
  if [[ "$output" != *"$expected"* ]]; then
    fail "expected '${expected}', got: ${output}"
  fi
}

cat > "$WORKFLOW" <<YAML
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - &checkout
        uses: "$approved_checkout"
        with:
          uses: unapproved/action@v1
      - *checkout
      - uses: "${approved_checkout/actions\/checkout/Actions\/Checkout}"
      - uses: "$approved_codeql"
      - uses: "${approved_codeql/\/init@/\/analyze@}"
      - uses: ./.github/actions/nested/example
      - run: |
          echo 'uses: unapproved/action@v1'
      - parallel:
          - uses: "$approved_checkout"
  reusable:
    uses: ./.github/workflows/reusable.yml
YAML
cat > "$ACTION" <<YAML
runs:
  using: composite
  steps:
    - uses: "$approved_checkout"
YAML
python3 "$CHECKER" "$TEST_ROOT" >/dev/null

write_reference() {
  cat > "$WORKFLOW" <<YAML
jobs:
  test:
    steps:
      - uses: $1
YAML
}

for ref in actions/checkout@v7 actions/checkout@main actions/checkout@3d3c42e; do
  write_reference "$ref"
  expect_failure "full 40-character commit SHA"
done
write_reference actions/checkout@0000000000000000000000000000000000000000
expect_failure "actions/checkout must use"
write_reference unapproved/action@0000000000000000000000000000000000000000
expect_failure "action is not in the allowlist"
write_reference "actions/checkout/sub-action@${approved_checkout##*@}"
expect_failure "action is not in the allowlist"
write_reference "null"
expect_failure "action reference must be a string"
write_reference docker://alpine:3
expect_failure "full 40-character commit SHA"
write_reference ./.github/actions/../../unscanned
expect_failure "full 40-character commit SHA"

cat > "$WORKFLOW" <<YAML
jobs:
  reusable:
    uses: unapproved/workflows/.github/workflows/test.yml@0000000000000000000000000000000000000000
YAML
expect_failure "action is not in the allowlist"

write_reference "$approved_checkout"
cat > "$ACTION" <<'YAML'
runs:
  using: composite
  steps:
    - uses: unapproved/action@0000000000000000000000000000000000000000
YAML
expect_failure ".github/actions/nested/example/action.yaml:runs.steps[0].uses"

cat > "$WORKFLOW" <<YAML
jobs:
  test:
    steps:
      - parallel:
          - uses: actions/checkout@v7
YAML
expect_failure "jobs.test.steps[0].parallel[0].uses"

printf 'jobs: [\n' > "$WORKFLOW"
expect_failure "cannot parse YAML"
rm "$WORKFLOW"
expect_failure "no workflow files found"

echo "action-pins policy fixtures: ok"
