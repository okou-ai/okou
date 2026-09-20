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
  $coverage["runs-on"] == "ubuntu-latest-8-cores" and
  $coverage["timeout-minutes"] == 20 and
  $coverage.env.CARGO_PROFILE_TEST_DEBUG == "line-tables-only" and
  $coverage.container.image == "ghcr.io/${{ github.repository_owner }}/vm0-toolchain-rust:20260825" and
  $coverage.needs == ["detect"] and
  $coverage.if == "needs.detect.outputs.any-changed == '\''true'\''" and
  any($coverage.steps[];
    .name == "Setup R2 sccache" and
    .if == "(github.event_name != '\''pull_request'\'' || (github.event.pull_request.user.login != '\''dependabot[bot]'\'' && github.event.pull_request.head.repo.full_name == github.repository))" and
    .uses == "./.github/actions/setup-r2-sccache" and
    .with.architecture == "x86_64" and
    .with["r2-access-key-id"] == "${{ secrets.R2_ACCESS_KEY_ID }}" and
    .with["r2-secret-access-key"] == "${{ secrets.R2_SECRET_ACCESS_KEY }}" and
    .with["r2-account-id"] == "${{ vars.R2_ACCOUNT_ID }}" and
    .with["r2-bucket-name"] == "${{ vars.R2_USER_STORAGES_BUCKET_NAME }}"
  ) and
  any($coverage.steps[];
    .uses == "Swatinem/rust-cache@42dc69e1aa15d09112580998cf2ef0119e2e91ae" and
    .with.workspaces == "crates -> target" and
    .with["shared-key"] == "coverage-line-tables-only" and
    .with["save-if"] == "${{ github.ref == '\''refs/heads/main'\'' }}"
  ) and
  any($coverage.steps[];
    .name == "Install cargo-llvm-cov" and
    .uses == "taiki-e/install-action@9114bf4d891761788c546334fd37538eae1bf8b3" and
    .with.tool == "cargo-llvm-cov@0.9.1"
  ) and
  any($coverage.steps[];
    .uses == "astral-sh/setup-uv@20cfd1bf945f4377ade1205e4dbc17946fc9a30d" and
    .with["working-directory"] == "crates/runner/mitm-addon" and
    .with["enable-cache"] == true
  ) and
  any($coverage.steps[];
    .name == "Sync locked addon for Rust/Python control integration" and
    .["working-directory"] == "crates/runner/mitm-addon" and
    .run == "uv sync --locked"
  ) and
  any($coverage.steps[];
    .name == "Run tests with coverage" and
    .run == "cd crates\ncargo llvm-cov --all-targets --all-features --lcov --output-path lcov.info\n"
  ) and
  any($coverage.steps[];
    .name == "Validate coverage report" and
    (.run | contains("[ -s \"$report\" ]")) and
    (.run | contains("awk -v root=\"${GITHUB_WORKSPACE}/\"")) and
    (.run | contains("LC_ALL=C sort -u")) and
    (.run | contains("sha256sum \"$source_files\""))
  ) and
  any($coverage.steps[];
    .name == "Upload coverage to Codecov" and
    .if == "success() || failure()" and
    .["continue-on-error"] == true and
    .["timeout-minutes"] == 1 and
    .uses == "codecov/codecov-action@v7" and
    .with.files == "crates/lcov.info" and
    .with.flags == "rust"
  ) and
  ($coverage.steps[-1] |
    .name == "Report peak memory" and
    .if == "always()" and
    .["continue-on-error"] == true and
    .uses == "./.github/actions/report-memory-peak"
  ) and
  ([.jobs | to_entries[] |
    select(any(.value.steps[]?; .uses == "./.github/actions/setup-r2-sccache")) |
    .key] == ["coverage"]) and
  ([.jobs | to_entries[] |
    select(any(.value.steps[]?;
      (.uses // "") | startswith("mozilla-actions/sccache-action@")
    )) |
    .key] == [])
' <<<"$workflow_json" >/dev/null || fail "coverage must retain its tested R2 sccache and reporting contract"

report_script=$(jq -r '.jobs.coverage.steps[] | select(.name == "Validate coverage report") | .run' <<<"$workflow_json")
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

step_index() {
  local needle=$1
  jq -r --arg needle "$needle" '
    .jobs.coverage.steps | to_entries[] |
    select((.value.name // .value.uses) == $needle) |
    .key
  ' <<<"$workflow_json"
}

checkout_index=$(step_index "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1")
sccache_index=$(step_index "Setup R2 sccache")
rust_cache_index=$(step_index "Swatinem/rust-cache@42dc69e1aa15d09112580998cf2ef0119e2e91ae")
install_index=$(step_index "Install cargo-llvm-cov")
coverage_index=$(step_index "Run tests with coverage")
report_index=$(step_index "Validate coverage report")
codecov_index=$(step_index "Upload coverage to Codecov")

for index in "$checkout_index" "$sccache_index" "$rust_cache_index" "$install_index" \
  "$coverage_index" "$report_index" "$codecov_index"; do
  [[ "$index" =~ ^[0-9]+$ ]] || fail "coverage workflow step index is missing"
done

((checkout_index < sccache_index)) || fail "sccache must start after checkout"
((sccache_index < rust_cache_index)) || fail "sccache must start before Cargo cache restoration"
((rust_cache_index < install_index)) || fail "the existing Rust cache must precede tool installation"
((install_index < coverage_index)) || fail "cargo-llvm-cov must be installed before coverage"
((coverage_index < report_index)) || fail "coverage report validation must follow coverage"
((report_index < codecov_index)) || fail "Codecov must consume the validated report"

echo "rust-coverage-cache-workflow-test: ok"
