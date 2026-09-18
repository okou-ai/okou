#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
WORKFLOW="${REPO_ROOT}/.github/workflows/runner-image.yml"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

command -v yq >/dev/null || fail "yq is required"
workflow_json=$(yq -o=json '.' "$WORKFLOW")

# Exercise the workflow's input detector with a transport-only Git change.
test_root=$(mktemp -d)
trap 'rm -rf "$test_root"' EXIT
fixture_git() {
  git -C "$test_root" -c user.name=Fixture -c user.email=fixture@example.com \
    -c commit.gpgsign=false -c core.hooksPath=/dev/null "$@"
}
fixture_git init --quiet
fixture_git commit --quiet --allow-empty -m baseline
base_ref=$(fixture_git rev-parse HEAD)
mkdir -p "${test_root}/.github/scripts"
cp "${SCRIPT_DIR}/runner-image-context.sh" "${SCRIPT_DIR}/runner-image-target.sh" \
  "${SCRIPT_DIR}/runner-binary-transport.sh" "${test_root}/.github/scripts/"
fixture_git add .github/scripts/runner-binary-transport.sh
fixture_git commit --quiet -m transport
image_input_step=$(jq -r '.jobs.prepare.steps[] | select(.id == "image-inputs") | .run' <<<"$workflow_json")
image_input_step=${image_input_step//"\${{ steps.crates.outputs.runner-changed }}"/false}
image_inputs=$(cd "$test_root" && BASE_REF="$base_ref" GITHUB_OUTPUT='' bash -c "$image_input_step")
grep -qx 'runner-image-inputs-changed=true' <<<"$image_inputs" || \
  fail "transport-only changes must be recognized as runner image inputs"

base_ref=$(fixture_git rev-parse HEAD)
cp "${SCRIPT_DIR}/runner-binary-download.sh" "${test_root}/.github/scripts/"
fixture_git add .github/scripts/runner-binary-download.sh
fixture_git commit --quiet -m download
image_inputs=$(cd "$test_root" && BASE_REF="$base_ref" GITHUB_OUTPUT='' bash -c "$image_input_step")
grep -qx 'runner-image-inputs-changed=true' <<<"$image_inputs" || \
  fail "download-only changes must be recognized as runner image inputs"

jq -e '
  .jobs.prepare.outputs["turbo-runner-consumer-needed"] ==
    "${{ steps.needed.outputs.turbo-runner-consumer-needed }}" and
  .jobs.prepare.outputs["playwright-runner-consumer-needed"] ==
    "${{ steps.needed.outputs.playwright-runner-consumer-needed }}" and
  any(.jobs.prepare.steps[];
    .id == "turbo" and
    (.run | contains(".github/scripts/runner-image-context.sh turbo-consumer")) and
    (.run | contains(".github/scripts/runner-image-context.sh playwright-consumer"))
  ) and
  any(.jobs.prepare.steps[];
    .id == "needed" and
    .env.TURBO_RUNNER_CONSUMER_NEEDED ==
      "${{ steps.turbo.outputs.turbo-runner-consumer-needed }}" and
    .env.PLAYWRIGHT_RUNNER_CONSUMER_NEEDED ==
      "${{ steps.turbo.outputs.playwright-runner-consumer-needed }}"
  )
' <<<"$workflow_json" >/dev/null || fail "Turbo and Playwright runner demand must reach runner image selection"

jq -e '
  .jobs["cancel-superseded"].name == "Cancel superseded merge-group CI" and
  .jobs["cancel-superseded"].if == "github.event_name == '\''merge_group'\''" and
  .jobs["cancel-superseded"].permissions.actions == "write" and
  .jobs["cancel-superseded"].permissions.contents == "read" and
  .jobs["cancel-superseded"].permissions["pull-requests"] == "read" and
  any(.jobs["cancel-superseded"].steps[];
    .run == ".github/scripts/cancel-superseded-merge-group-runs.sh"
  ) and
  .jobs.prepare.needs == ["cancel-superseded"] and
  (.jobs.prepare.if | contains("!cancelled()")) and
  (.jobs.prepare.if | contains("needs.cancel-superseded.result == '\''success'\''"))
' <<<"$workflow_json" >/dev/null || fail "merge-group consumers must stop before shared runner resources are rebuilt"

jq -e '
  [.jobs | to_entries[] | .value.steps[]? |
    select((.run // "") | startswith(".github/scripts/runner-binary-transport.sh "))
  ] as $transports |
  ($transports | length) == 3 and
  all($transports[];
    .env.CURRENT_RUN_ID == "${{ github.run_id }}" and
    .env.REPO == "${{ github.repository }}" and
    .env.EXPECTED_TARGET == "${{ matrix.target }}" and
    .env.AWS_ACCESS_KEY_ID == "${{ secrets.R2_ACCESS_KEY_ID }}" and
    .env.AWS_SECRET_ACCESS_KEY == "${{ secrets.R2_SECRET_ACCESS_KEY }}" and
    .env.R2_BUCKET_NAME == "${{ vars.R2_USER_STORAGES_BUCKET_NAME }}" and
    (. | has("continue-on-error") | not)
  )
' <<<"$workflow_json" >/dev/null || fail "runner binary transport identity must survive producer and consumer attempt mismatch"

jq -e '
  .jobs.prepare["runs-on"] == "ubuntu-latest" and
  (.jobs.prepare | has("container") | not) and
  .jobs.prepare.permissions.actions == "read" and
  .jobs.prepare.outputs["runner-binary-compile-matrix"] == "${{ steps.binary-plan.outputs.compile-matrix }}" and
  .jobs.prepare.outputs["runner-binary-hit-references"] == "${{ steps.binary-plan.outputs.hit-references }}" and
  any(.jobs.prepare.steps[];
    .id == "binary-plan" and
    .run == ".github/scripts/runner-binary-cache-plan.sh" and
    .env.RUNNER_BINARY_CACHE_FORCE_MISS == "${{ vars.RUNNER_BINARY_CACHE_FORCE_MISS }}"
  )
' <<<"$workflow_json" >/dev/null || fail "prepare must publish cache references and the miss-only compile matrix"

jq -e '
  .jobs.compile["runs-on"] == "ubuntu-latest-8-cores" and
  .jobs.compile.container.image == "ghcr.io/vm0-ai/vm0-toolchain-rust:20260825" and
  (.jobs.compile.if | contains("!cancelled()")) and
  (.jobs.compile.if | contains("needs.prepare.result == '\''success'\''")) and
  (.jobs.compile.if | contains("runner-binary-miss-count != '\''0'\''")) and
  .jobs.compile.strategy.matrix.include == "${{ fromJSON(needs.prepare.outputs.runner-binary-compile-matrix) }}" and
  any(.jobs.compile.steps[];
    .name == "Configure git safe directory" and
    .shell == "bash" and
    .run == "git config --global --add safe.directory \"$GITHUB_WORKSPACE\""
  ) and
  ((.jobs.compile.steps | map(.uses // .name) | index("Configure git safe directory")) <
    (.jobs.compile.steps | map(.uses // .name) | index("Build runner binary"))) and
  any(.jobs.compile.steps[]; .uses == "mozilla-actions/sccache-action@fc920bf0ec8de6ee65d409111f7ec508035751ba") and
  any(.jobs.compile.steps[]; .uses == "Swatinem/rust-cache@v2") and
  any(.jobs.compile.steps[]; .run == ".github/scripts/runner-binary-build/build.sh build") and
  any(.jobs.compile.steps[];
    .run == ".github/scripts/runner-binary-transport.sh publish" and
    .env.EXPECTED_BINARY_INPUT_DIGEST == "${{ steps.build.outputs.binary-input-digest }}" and
    .env.PRODUCER_RUN_ATTEMPT == "${{ github.run_attempt }}" and
    (. | has("continue-on-error") | not)
  )
' <<<"$workflow_json" >/dev/null || fail "compile must be a required miss-only Rust/cache/build matrix"

# Execute the configured startup boundary without contacting storage. The
# server must receive R2 configuration, while later build steps receive only
# compiler settings through GITHUB_ENV.
cache_step=$(jq -c '.jobs.compile.steps[] | select(.name == "Configure sccache")' <<<"$workflow_json")
cache_script=$(jq -r '.run' <<<"$cache_step")
cache_env_entries=$(jq -r '.env | to_entries[] | "\(.key)=\(.value)"' <<<"$cache_step")
mapfile -t cache_env <<<"$cache_env_entries"
for index in "${!cache_env[@]}"; do
  value=${cache_env[$index]}
  value=${value//"\${{ secrets.R2_ACCESS_KEY_ID }}"/fixture-access}
  value=${value//"\${{ secrets.R2_SECRET_ACCESS_KEY }}"/fixture-secret}
  value=${value//"\${{ vars.R2_ACCOUNT_ID }}"/fixture-account}
  value=${value//"\${{ vars.R2_USER_STORAGES_BUCKET_NAME }}"/fixture-bucket}
  value=${value//"\${{ matrix.id }}"/arm64}
  cache_env[index]=$value
done
cache_dir="${test_root}/cache-startup"
mkdir -p "$cache_dir"
cat > "${cache_dir}/sccache" <<'BASH'
#!/usr/bin/env bash
set -euo pipefail
[ "$#" = 1 ] && [ "$1" = --start-server ]
[ "$AWS_ACCESS_KEY_ID" = fixture-access ]
[ "$AWS_SECRET_ACCESS_KEY" = fixture-secret ]
[ "$SCCACHE_BUCKET" = fixture-bucket ]
[ "$SCCACHE_ENDPOINT" = https://fixture-account.r2.cloudflarestorage.com ]
[ "$SCCACHE_REGION" = auto ]
[ "$SCCACHE_S3_KEY_PREFIX" = runner-sccache/arm64/ ]
[ "$SCCACHE_GHA_ENABLED" = false ]
[ "$SCCACHE_IDLE_TIMEOUT" = 0 ]
[ -f "$SCCACHE_CONF" ]
touch "$SERVER_STARTED"
BASH
chmod +x "${cache_dir}/sccache"
cache_start_env=(env -i "PATH=$PATH" "RUNNER_TEMP=$cache_dir"
  "GITHUB_ENV=${cache_dir}/github-env" "SCCACHE_PATH=${cache_dir}/sccache"
  "SERVER_STARTED=${cache_dir}/started" "${cache_env[@]}")
"${cache_start_env[@]}" bash -eo pipefail -c "$cache_script"
[ -f "${cache_dir}/started" ] || fail "R2 cache server did not start"
if grep -Eq 'AWS_|R2_|SCCACHE_(BUCKET|ENDPOINT)|fixture-(access|secret)' "${cache_dir}/github-env"; then
  fail "cache startup must not export storage configuration or credentials to build steps"
fi
grep -qx 'RUSTC_WRAPPER=sccache' "${cache_dir}/github-env" || fail "builds must use the configured cache server"
for missing in AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY R2_ACCOUNT_ID SCCACHE_BUCKET; do
  rm -f "${cache_dir}/started"
  if "${cache_start_env[@]}" "$missing=" bash -eo pipefail -c "$cache_script" \
    >"${cache_dir}/out" 2>"${cache_dir}/err"; then
    fail "cache startup must reject missing $missing"
  fi
  [ ! -e "${cache_dir}/started" ] || fail "missing R2 configuration must not start a local cache"
done

jq -e '
  ([.jobs | to_entries[] |
    select(any(.value.steps[]?; .uses == "mozilla-actions/sccache-action@fc920bf0ec8de6ee65d409111f7ec508035751ba")) |
    .key] == ["compile"]) and
  ([.jobs | to_entries[] |
    select(any(.value.steps[]?; .uses == "Swatinem/rust-cache@v2")) |
    .key] == ["compile"])
' <<<"$workflow_json" >/dev/null || fail "compiler caches must exist only in the miss-only compile job"

jq -e '
  .jobs.build.name == "Build runner image (${{ matrix.label }})" and
  .jobs.build["runs-on"] == "ubuntu-latest" and
  .jobs.build["timeout-minutes"] == 20 and
  (.jobs.build | has("container") | not) and
  .jobs.build.strategy.matrix.include == "${{ fromJSON(needs.prepare.outputs.runner-host-groups-matrix) }}" and
  (.jobs.build.if | contains("needs.compile.result == '\''skipped'\''")) and
  (.jobs.build.if | contains("needs.compile.result == '\''success'\''")) and
  any(.jobs.build.steps[];
    .name == "Download cached runner binary from R2" and
    (.if | contains("runner-binary-hit-targets")) and
    .run == ".github/scripts/runner-binary-cache.sh download-reference" and
    .env.CACHE_REFERENCE == "${{ toJSON(fromJSON(needs.prepare.outputs.runner-binary-hit-references)[matrix.target]) }}" and
    .env.RESOLVE_OUTPUT_DIR == "runner-binary-transport/${{ matrix.target }}"
  ) and
  any(.jobs.build.steps[];
    .run == ".github/scripts/runner-binary-transport.sh download" and
    (.if | contains("!contains(")) and
    .env.EXPECTED_BINARY_INPUT_DIGEST == "${{ steps.binary-input.outputs.binary-input-digest }}" and
    .env.OUTPUT_DIR == "runner-binary-transport/${{ matrix.target }}"
  ) and
  any(.jobs.build.steps[];
    .run == ".github/scripts/prepare-runner-image.sh" and
    .env.RUNNER_PATH == "runner-binary-transport/${{ matrix.target }}/runner" and
    .env.EXPECTED_BINARY_INPUT_DIGEST == "${{ steps.binary-input.outputs.binary-input-digest }}"
  )
' <<<"$workflow_json" >/dev/null || fail "build must preserve the all-target host readiness contract for hits and misses"

jq -e '
  (.jobs.asset.needs | sort) == ["compile", "prepare"] and
  (.jobs.asset.if | contains("runner-binary-miss-count != '\''0'\''")) and
  .jobs.asset.strategy.matrix.include == "${{ fromJSON(needs.prepare.outputs.runner-binary-compile-matrix) }}" and
  any(.jobs.asset.steps[];
    .run == ".github/scripts/runner-binary-transport.sh download" and
    .env.EXPECTED_BINARY_INPUT_DIGEST == "${{ steps.binary-input.outputs.binary-input-digest }}" and
    .env.OUTPUT_DIR == "runner-binary-fresh"
  ) and
  any(.jobs.asset.steps[];
    .name == "Validate fresh runner binary" and
    (. | has("if") | not) and
    (. | has("continue-on-error") | not)
  ) and
  any(.jobs.asset.steps[];
    .name == "Resolve reusable candidate in shadow mode" and
    (. | has("if") | not)
  ) and
  any(.jobs.asset.steps[];
    .name == "Upload reusable runner binary manifest" and
    .with.path == "runner-binary-fresh/manifest.json" and
    .with["retention-days"] == 7
  )
' <<<"$workflow_json" >/dev/null || fail "reusable publication must run only for compiled misses"

prepare_consumers=$(jq -r '[.jobs | to_entries[] |
  select(any(.value.steps[]?; .run == ".github/scripts/prepare-runner-image.sh")) |
  .key] | join(",")' <<<"$workflow_json")
[ "$prepare_consumers" = "build" ] || fail "host preparation must run only in the all-target build job"

echo "runner-image-workflow-test: ok"
