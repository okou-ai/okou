#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
WORKFLOW="${REPO_ROOT}/.github/workflows/runner-image.yml"
ACTION="${REPO_ROOT}/.github/actions/setup-r2-sccache/action.yml"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

command -v yq >/dev/null || fail "yq is required"
architecture_json=$(yq -o=json '.' "${REPO_ROOT}/.github/workflows/runner-image-architecture.yml")
workflow_json=$(yq -o=json '.' "$WORKFLOW" |
  jq --argjson architecture "$architecture_json" '. + {architecture: $architecture}')

jq -e '
  .jobs.prepare.steps as $steps |
  ($steps | map(.id // "") | index("identity")) as $identity |
  ($steps | map(.id // "") | index("turbo-cache")) as $cache |
  ($steps | map(.id // "") | index("turbo")) as $detect |
  ($identity < $cache and $cache < $detect) and
  ($steps[$cache].uses | startswith("actions/cache@")) and
  $steps[$cache].if == $steps[$detect].if and
  $steps[$cache].if == "steps.identity.outputs.release-skip != '\''true'\''" and
  $steps[$cache].with.path ==
    "${{ runner.temp }}/runner-image-turbo-npm/_cacache\n${{ runner.temp }}/runner-image-turbo-npm/_npx\n" and
  $steps[$cache].with.key ==
    "runner-image-turbo-${{ runner.os }}-${{ runner.arch }}-${{ hashFiles('\''scripts/changed.sh'\'') }}" and
  ($steps[$cache].with | has("restore-keys") | not) and
  $steps[$detect].env.npm_config_cache == "${{ runner.temp }}/runner-image-turbo-npm" and
  $steps[$detect].env.npm_config_prefer_offline == "true" and
  ($steps[$detect].env | has("npm_config_offline") | not) and
  ($steps[$detect].run | contains("CHANGES_JSON=$(./scripts/changed.sh")) and
  (.jobs.prepare.env // {} | has("npm_config_cache") | not)
' <<<"$workflow_json" >/dev/null || fail "Turbo detection must use its pinned tool cache without changing CLI cache ownership or release skips"

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

check_ci_detectors() {
  local base_ref=$1 change_label=$2 include_turbo=${3:-false}
  ruby -ryaml -ropen3 - "$REPO_ROOT" "$test_root" "$base_ref" "$change_label" "$include_turbo" <<'RUBY'
root, fixture, base, change_label, include_turbo = ARGV
detectors = [["crates", "detect", "detect", "base-ref"],
             ["runner-image", "prepare", "turbo", "base-ref"],
             ["runner-image", "prepare", "crates", "base-ref"]]
detectors << ["turbo", "prepare", "detect", "changed-files"] if include_turbo == "true"
detectors.each do |workflow, job, step_id, input|
  steps = YAML.load_file("#{root}/.github/workflows/#{workflow}.yml").fetch("jobs").fetch(job).fetch("steps")
  lines = steps.find { |step| step["id"] == step_id }.fetch("run").lines
  first = lines.index { |line| line.start_with?("if ") && line.include?(".github/actions/") }
  raise "missing CI detector: #{workflow}/#{step_id}" unless first
  last = (first...lines.length).find { |index| lines[index].strip == "fi" }
  # Execute the workflow's actual selection boundary against a real Git diff.
  script = lines[first..last].join + "\necho \"ci-changed=${ci_changed:-}\"\n"
  output_file = "#{fixture}/detected"
  [base, "HEAD"].each do |comparison|
    File.write(output_file, "")
    env = {"GITHUB_OUTPUT" => output_file}
    if input == "base-ref"
      env["BASE_REF"] = comparison
    else
      changed_files, error, status = Open3.capture3("git", "diff", "--name-only", comparison, "HEAD", chdir: fixture)
      raise error unless status.success?
      env["CHANGED_FILES"] = changed_files
    end
    output, error, status = Open3.capture3(env,
                                         "bash", "-e", "-o", "pipefail", "-c", script, chdir: fixture)
    raise error unless status.success?
    expected = comparison == base ? "true" : "false"
    result = output + File.read(output_file)
    unless result.lines.include?("ci-changed=#{expected}\n")
      raise "wrong #{change_label} selection: #{workflow}/#{step_id}"
    end
  end
end
RUBY
}

# An installer-only edit must still select its image and native test consumers.
base_ref=$(fixture_git rev-parse HEAD)
mkdir -p "${test_root}/.github/actions/setup-aws-cli"
cp "${REPO_ROOT}/.github/actions/setup-aws-cli/action.yml" \
  "${test_root}/.github/actions/setup-aws-cli/action.yml"
fixture_git add .github/actions/setup-aws-cli/action.yml
fixture_git commit --quiet -m installer
image_inputs=$(cd "$test_root" && BASE_REF="$base_ref" GITHUB_OUTPUT='' bash -c "$image_input_step")
grep -qx 'runner-image-inputs-changed=true' <<<"$image_inputs" || \
  fail "installer-only changes must be recognized as runner image inputs"
check_ci_detectors "$base_ref" "installer"

# A shared-cache-action-only edit must select the same image and consumers.
base_ref=$(fixture_git rev-parse HEAD)
mkdir -p "${test_root}/.github/actions/setup-r2-sccache"
cp "$ACTION" "${test_root}/.github/actions/setup-r2-sccache/action.yml"
fixture_git add .github/actions/setup-r2-sccache/action.yml
fixture_git commit --quiet -m shared-cache-action
image_inputs=$(cd "$test_root" && BASE_REF="$base_ref" GITHUB_OUTPUT='' bash -c "$image_input_step")
grep -qx 'runner-image-inputs-changed=true' <<<"$image_inputs" || \
  fail "shared cache action changes must be recognized as runner image inputs"
check_ci_detectors "$base_ref" "shared cache action" true

# A reusable-owner-only edit must select every producer and CI consumer.
base_ref=$(fixture_git rev-parse HEAD)
mkdir -p "${test_root}/.github/workflows"
cp "${REPO_ROOT}/.github/workflows/runner-image-architecture.yml" \
  "${test_root}/.github/workflows/runner-image-architecture.yml"
fixture_git add .github/workflows/runner-image-architecture.yml
fixture_git commit --quiet -m architecture-workflow
image_inputs=$(cd "$test_root" && BASE_REF="$base_ref" GITHUB_OUTPUT='' bash -c "$image_input_step")
grep -qx 'runner-image-inputs-changed=true' <<<"$image_inputs" || \
  fail "architecture workflow changes must be recognized as runner image inputs"
check_ci_detectors "$base_ref" "architecture workflow" true

# The shared readiness guard is also an image input, without a crate edit.
base_ref=$(fixture_git rev-parse HEAD)
cp "${SCRIPT_DIR}/runner-image-architecture.sh" "${test_root}/.github/scripts/"
fixture_git add .github/scripts/runner-image-architecture.sh
fixture_git commit --quiet -m architecture-guard
image_inputs=$(cd "$test_root" && BASE_REF="$base_ref" GITHUB_OUTPUT='' bash -c "$image_input_step")
grep -qx 'runner-image-inputs-changed=true' <<<"$image_inputs" || \
  fail "architecture guard changes must be recognized as runner image inputs"
check_ci_detectors "$base_ref" "architecture guard" true

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
  [.jobs, .architecture.jobs | to_entries[] | .value.steps[]? |
    select((.run // "") | startswith(".github/scripts/runner-binary-transport.sh "))
  ] as $transports |
  ($transports | length) == 2 and
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
  .jobs.prepare.outputs["runner-binary-hit-matrix"] == "${{ steps.binary-plan.outputs.hit-matrix }}" and
  .jobs.prepare.outputs["runner-binary-hit-references"] == "${{ steps.binary-plan.outputs.hit-references }}" and
  any(.jobs.prepare.steps[];
    .id == "binary-plan" and
    .run == ".github/scripts/runner-binary-cache-plan.sh" and
    .env.RUNNER_BINARY_CACHE_FORCE_MISS == "${{ vars.RUNNER_BINARY_CACHE_FORCE_MISS }}"
  )
' <<<"$workflow_json" >/dev/null || fail "prepare must publish cache references and the miss-only compile matrix"

jq -e '
  .architecture.jobs.compile["runs-on"] == "ubuntu-latest-8-cores" and
  .architecture.jobs.compile.container.image == "ghcr.io/${{ github.repository_owner }}/vm0-toolchain-rust:20261009" and
  (.architecture.jobs.compile.if | contains("!cancelled()")) and
  (.architecture.jobs.compile.if | contains("!inputs.cache-hit")) and
  .architecture.jobs.compile.strategy.matrix.include == "${{ fromJSON(format('\''[{0}]'\'', inputs.architecture-json)) }}" and
  any(.architecture.jobs.compile.steps[];
    .name == "Configure git safe directory" and
    .shell == "bash" and
    .run == "git config --global --add safe.directory \"$GITHUB_WORKSPACE\""
  ) and
  ((.architecture.jobs.compile.steps | map(.uses // .name) | index("Configure git safe directory")) <
    (.architecture.jobs.compile.steps | map(.uses // .name) | index("Build runner binary"))) and
  any(.architecture.jobs.compile.steps[];
    .name == "Setup R2 sccache" and
    .uses == "./.github/actions/setup-r2-sccache" and
    .with.architecture == "${{ matrix.id }}" and
    .with["r2-access-key-id"] == "${{ secrets.R2_ACCESS_KEY_ID }}" and
    .with["r2-secret-access-key"] == "${{ secrets.R2_SECRET_ACCESS_KEY }}" and
    .with["r2-account-id"] == "${{ vars.R2_ACCOUNT_ID }}" and
    .with["r2-bucket-name"] == "${{ vars.R2_USER_STORAGES_BUCKET_NAME }}"
  ) and
  any(.architecture.jobs.compile.steps[]; (.uses // "") | startswith("Swatinem/rust-cache@")) and
  any(.architecture.jobs.compile.steps[]; .run == ".github/scripts/runner-binary-build/build.sh build") and
  any(.architecture.jobs.compile.steps[];
    .run == ".github/scripts/runner-binary-transport.sh publish" and
    .env.EXPECTED_BINARY_INPUT_DIGEST == "${{ steps.build.outputs.binary-input-digest }}" and
    .env.PRODUCER_RUN_ATTEMPT == "${{ github.run_attempt }}" and
    (. | has("continue-on-error") | not)
  )
' <<<"$workflow_json" >/dev/null || fail "compile must be a required miss-only Rust/cache/build matrix"

jq -e '
  ([.jobs, .architecture.jobs | to_entries[] |
    select(any(.value.steps[]?; .uses == "./.github/actions/setup-r2-sccache")) |
    .key] | sort) == ["compile", "prewarm-rust-cache"] and
  ([.jobs, .architecture.jobs | to_entries[] |
    select(any(.value.steps[]?; (.uses // "") | startswith("Swatinem/rust-cache@"))) |
    .key] | sort) == ["compile", "prewarm-rust-cache"]
' <<<"$workflow_json" >/dev/null || fail "compiler caches must stay in the miss-only compiler and main dependency prewarmer"

jq -e '
  .architecture.jobs.build.name == "Build runner image (${{ matrix.label }})" and
  (.architecture.jobs.build.needs | sort) == ["compile"] and
  .architecture.jobs.build["runs-on"] == "ubuntu-latest" and
  .architecture.jobs.build["timeout-minutes"] == 20 and
  (.architecture.jobs.build | has("container") | not) and
  .architecture.jobs.build.strategy.matrix.include == "${{ fromJSON(format('\''[{0}]'\'', inputs.architecture-json)) }}" and
  (.architecture.jobs.build.if | contains("always()")) and
  (.architecture.jobs.build.if | contains("!cancelled()")) and
  any(.architecture.jobs.build.steps[];
    .run == ".github/scripts/runner-image-architecture.sh build-ready" and
    .env.RUNNER_IMAGE_COMPILE_RESULT == "${{ needs.compile.result }}" and
    .env.RUNNER_IMAGE_CACHE_HIT == "${{ inputs.cache-hit }}"
  ) and
  .architecture.jobs.build.env.GUEST_CLI_PATH == "runner-cli-intermediate/package.tgz" and
  .architecture.jobs.build.env.GUEST_CLI_MANIFEST_PATH == "runner-cli-intermediate/manifest.json" and
  any(.architecture.jobs.build.steps[];
    .name == "Download cached runner binary from R2" and
    .if == "inputs.cache-hit" and
    .run == ".github/scripts/runner-binary-cache.sh download-reference" and
    .env.CACHE_REFERENCE == "${{ inputs.cache-reference }}" and
    .env.RESOLVE_OUTPUT_DIR == "runner-binary-transport/${{ matrix.target }}"
  ) and
  any(.architecture.jobs.build.steps[];
    .run == ".github/scripts/runner-binary-transport.sh download" and
    (.if | contains("!inputs.cache-hit")) and
    .env.EXPECTED_BINARY_INPUT_DIGEST == "${{ steps.binary-input.outputs.binary-input-digest }}" and
    .env.OUTPUT_DIR == "runner-binary-transport/${{ matrix.target }}"
  ) and
  any(.architecture.jobs.build.steps[];
    .run == ".github/scripts/prepare-runner-image.sh" and
    .env.RUNNER_PATH == "runner-binary-transport/${{ matrix.target }}/runner" and
    .env.EXPECTED_BINARY_INPUT_DIGEST == "${{ steps.binary-input.outputs.binary-input-digest }}"
  ) and
  any(.architecture.jobs.build.steps[];
    .name == "Upload runner image manifest" and
    ((.uses // "") | startswith("actions/upload-artifact@")) and
    .with.name == "${{ steps.artifact.outputs.artifact-name }}" and
    .with.path == "runner-image-manifest/manifest.json" and
    .with.overwrite == true and
    .with["retention-days"] == 7
  )
' <<<"$workflow_json" >/dev/null || fail "build must preserve host readiness and republish its verified manifest on retry"

jq -e '
  .architecture.jobs.compile.steps as $steps |
  ($steps | map(.id // "") | index("build")) as $build |
  ($steps | map(.id // "") | index("fresh")) as $fresh |
  ($steps | map(.id // "") | index("transport")) as $transport |
  ($steps | map(.id // "") | index("shadow")) as $shadow |
  ($steps | map(.id // "") | index("artifact")) as $artifact |
  ($steps | map(.id // "") | index("manifest-upload")) as $upload |
  (.architecture.jobs.compile | has("needs") | not) and
  .architecture.jobs.compile.strategy["fail-fast"] == false and
  .architecture.jobs.compile.permissions == {actions: "read", contents: "read"} and
  ($build < $fresh and $fresh < $transport and $transport < $shadow and $shadow < $artifact and $artifact < $upload) and
  all([$fresh, $transport, $shadow, $artifact][];
    . as $index | ($steps[$index] | has("if") | not) and
    ($steps[$index] | has("continue-on-error") | not)
  ) and
  ($steps[$fresh].run | contains(".github/scripts/runner-binary-cache.sh fresh-validate")) and
  $steps[$shadow].env.EXPECTED_BINARY_INPUT_DIGEST == "${{ steps.build.outputs.binary-input-digest }}" and
  $steps[$shadow].env.FRESH_METADATA_PATH == "runner-binary-fresh/metadata.json" and
  $steps[$shadow].env.RUNNER_PATH == "runner-binary-fresh/runner" and
  $steps[$shadow].env.GH_TOKEN == "${{ github.token }}" and
  $steps[$shadow].env.CURRENT_RUN_ID == "${{ github.run_id }}" and
  $steps[$shadow].env.CURRENT_EVENT == "${{ github.event_name }}" and
  $steps[$shadow].env.CURRENT_PR_HEAD_REF == "${{ inputs.pr-head-ref }}" and
  $steps[$shadow].env.CURRENT_PR_NUMBER == "${{ inputs.pr-number }}" and
  ($steps[$shadow].run | contains(".github/scripts/runner-binary-cache.sh shadow-resolve")) and
  $steps[$artifact].env.EXPECTED_BINARY_INPUT_DIGEST == "${{ steps.build.outputs.binary-input-digest }}" and
  $steps[$upload]["continue-on-error"] == true and
  ($steps[$upload] | has("if") | not) and
  $steps[$upload].with.path == ($steps[$transport].env.OUTPUT_DIR + "/manifest.json") and
  $steps[$upload].with.name == "${{ steps.artifact.outputs.artifact-name }}" and
  $steps[$upload].with["if-no-files-found"] == "error" and
  $steps[$upload].with["retention-days"] == 7 and
  ($steps[$upload].with | has("overwrite") | not) and
  all($steps[]; (.name // "") != "Install GitHub CLI")
' <<<"$workflow_json" >/dev/null || fail "each compiler must authorize its immutable index after verified publication and shadow auditing"

prepare_consumers=$(jq -r '[.jobs, .architecture.jobs | to_entries[] |
  select(any(.value.steps[]?; .run == ".github/scripts/prepare-runner-image.sh")) |
  .key] | join(",")' <<<"$workflow_json")
[ "$prepare_consumers" = "build" ] || fail "host preparation must run only in the architecture-owned build job"

echo "runner-image-workflow-test: ok"
