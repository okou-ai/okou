#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
WORKFLOW="${REPO_ROOT}/.github/workflows/crates.yml"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

for command in jq yq; do
  command -v "$command" >/dev/null || fail "$command is required"
done

workflow_json=$(yq -o=json '.' "$WORKFLOW")

jq -e '
  .jobs.coverage as $coverage |
  any($coverage.steps[];
    .if == "(github.event_name != '\''pull_request'\'' || (github.event.pull_request.user.login != '\''dependabot[bot]'\'' && github.event.pull_request.head.repo.full_name == github.repository))" and
    .uses == "./.github/actions/setup-r2-sccache" and
    .with.architecture == "x86_64" and
    .with["r2-access-key-id"] == "${{ secrets.R2_ACCESS_KEY_ID }}" and
    .with["r2-secret-access-key"] == "${{ secrets.R2_SECRET_ACCESS_KEY }}" and
    .with["r2-account-id"] == "${{ vars.R2_ACCOUNT_ID }}" and
    .with["r2-bucket-name"] == "${{ vars.R2_USER_STORAGES_BUCKET_NAME }}"
  ) and
  any($coverage.steps[];
    ((.uses // "") | startswith("Swatinem/rust-cache@")) and
    .with["save-if"] == "${{ github.ref == '\''refs/heads/main'\'' }}"
  ) and
  any($coverage.steps[];
    .if == "success() || failure()" and
    .["continue-on-error"] == true and
    ((.uses // "") | startswith("codecov/codecov-action@")) and
    .with.files == "crates/lcov.info"
  )
' <<<"$workflow_json" >/dev/null || fail "coverage must retain its tested R2 sccache and reporting contract"

report_script=$(jq -r '.jobs.coverage.steps[] | select((.run // "" | contains("lcov.info")) and (.run // "" | contains("cargo llvm-cov") | not)) | .run' <<<"$workflow_json")
test_root=$(mktemp -d)
trap 'rm -rf "$test_root"' EXIT
mkdir -p "${test_root}/crates" "${test_root}/runner-temp"
printf '%s\n' \
  "TN:" \
  "SF:${test_root}/crates/src/lib.rs" \
  "DA:1,1" \
  "end_of_record" \
  "SF:crates/src/main.rs" \
  "DA:1,1" \
  "end_of_record" \
  "SF:${test_root}/crates/src/lib.rs" \
  >"${test_root}/crates/lcov.info"
report_output=$(
  cd "$test_root"
  GITHUB_WORKSPACE="$test_root" RUNNER_TEMP="${test_root}/runner-temp" \
    sh -eu -c "$report_script"
)
printf '%s\n' "crates/src/lib.rs" "crates/src/main.rs" |
  LC_ALL=C sort -u >"${test_root}/expected-source-files.txt"
expected_digest=$(sha256sum "${test_root}/expected-source-files.txt" | cut -d ' ' -f 1)
grep -Fqx 'Coverage source files: 2' <<<"$report_output" ||
  fail "coverage report summary must count unique source files"
grep -Fqx "Coverage source file set SHA-256: ${expected_digest}" <<<"$report_output" ||
  fail "coverage report summary must normalize and hash the source-file set"

# Codecov must consume the report produced by the selected coverage command.
coverage_index=$(jq -r '.jobs.coverage.steps | to_entries[] |
  select(.value.run // "" | contains("cargo llvm-cov")) | .key' <<<"$workflow_json")
report_index=$(jq -r '.jobs.coverage.steps | to_entries[] |
  select((.value.run // "" | contains("lcov.info")) and
    (.value.run // "" | contains("cargo llvm-cov") | not)) | .key' <<<"$workflow_json")
codecov_index=$(jq -r '.jobs.coverage.steps | to_entries[] |
  select(.value.uses // "" | startswith("codecov/codecov-action@")) | .key' <<<"$workflow_json")
for index in "$coverage_index" "$report_index" "$codecov_index"; do
  [[ "$index" =~ ^[0-9]+$ ]] || fail "coverage workflow step index is missing"
done
((coverage_index < report_index)) || fail "coverage report validation must follow coverage"
((report_index < codecov_index)) || fail "Codecov must consume the validated report"

echo "rust-coverage-cache-workflow-test: ok"
