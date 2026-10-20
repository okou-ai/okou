#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
runner_json=$(ruby -ryaml -rjson -e 'puts JSON.generate(YAML.load_file(ARGV.fetch(0)))' \
  "${REPO_ROOT}/.github/workflows/runner-image.yml")
architecture_json=$(ruby -ryaml -rjson -e 'puts JSON.generate(YAML.load_file(ARGV.fetch(0)))' \
  "${REPO_ROOT}/.github/workflows/runner-image-architecture.yml")
runner_json=$(jq --argjson architecture "$architecture_json" '. + {architecture: $architecture}' <<<"$runner_json")
release_json=$(ruby -ryaml -rjson -e 'puts JSON.generate(YAML.load_file(ARGV.fetch(0)))' \
  "${REPO_ROOT}/.github/workflows/release-please.yml")
crates_json=$(ruby -ryaml -rjson -e 'puts JSON.generate(YAML.load_file(ARGV.fetch(0)))' \
  "${REPO_ROOT}/.github/workflows/crates.yml")

jq -e '
  . as $root |
  .jobs.prepare.steps as $steps |
  ($steps | map(((.uses // "") | startswith("actions/checkout@")) and
    .with.ref == "${{ github.sha }}") | index(true)) as $checkout |
  ($steps | map(.uses // "" | . == "./.github/actions/build-runner-cli") | index(true)) as $build |
  ($steps | map(((.uses // "") | startswith("actions/upload-artifact@")) and
    .with.name == "runner-cli-${{ github.run_id }}-${{ github.run_attempt }}") | index(true)) as $upload |
  ($steps | map(.id // "") | index("binary-plan")) as $plan |
  ($checkout < $build and $build < $upload and $upload < $plan) and
  .jobs.prepare.outputs["head-sha"] == "${{ steps.identity.outputs.head-sha }}" and
  .jobs.prepare.outputs["producer-head-sha"] == "${{ steps.identity.outputs.producer-head-sha }}" and
  any($steps[];
    .id == "identity" and
    .env.HEAD_SHA == "${{ github.sha }}" and
    .env.PRODUCER_HEAD_SHA == "${{ github.event.pull_request.head.sha || github.sha }}"
  ) and
  ([$steps[] | select((.uses // "") | startswith("actions/checkout@"))] | length == 1) and
  $steps[$build].with["source-sha"] == "${{ steps.identity.outputs.head-sha }}" and
  ($steps[$upload].with.path | split("\n") | index("runner-cli-intermediate/package.tgz") != null and index("runner-cli-intermediate/manifest.json") != null) and
  $steps[$upload].with.name == "runner-cli-${{ github.run_id }}-${{ github.run_attempt }}" and
  ($steps[$upload].with | has("overwrite") | not) and
  $steps[$plan].env.GUEST_CLI_PATH == "runner-cli-intermediate/package.tgz" and
  $steps[$plan].env.GUEST_CLI_MANIFEST_PATH == "runner-cli-intermediate/manifest.json" and
  $steps[$plan].env.RUNNER_BINARY_GIT_REVISION == "${{ steps.identity.outputs.head-sha }}" and
  (["compile", "build"] | all(.[]; . as $job |
    $root.architecture.jobs[$job].env.GUEST_CLI_PATH == "runner-cli-intermediate/package.tgz" and
    $root.architecture.jobs[$job].env.GUEST_CLI_MANIFEST_PATH == "runner-cli-intermediate/manifest.json" and
    $root.architecture.jobs[$job].env.RUNNER_BINARY_GIT_REVISION == "${{ inputs.head-sha }}" and
    ([$root.architecture.jobs[$job].steps[] | select((.uses // "") | startswith("actions/checkout@"))] |
      length == 1 and .[0].with.ref == "${{ inputs.head-sha }}") and
    any($root.architecture.jobs[$job].steps[];
      ((.uses // "") | startswith("actions/download-artifact@")) and
      .with["artifact-ids"] == "${{ inputs.cli-artifact-id }}")
  )) and
  .jobs["prewarm-rust-cache"].env.GUEST_CLI_PATH == "runner-cli-intermediate/package.tgz" and
  .jobs["prewarm-rust-cache"].env.GUEST_CLI_MANIFEST_PATH == "runner-cli-intermediate/manifest.json" and
  .jobs["prewarm-rust-cache"].env.RUNNER_BINARY_GIT_REVISION == "${{ needs.prepare.outputs.head-sha }}" and
  ([.jobs["prewarm-rust-cache"].steps[] | select((.uses // "") | startswith("actions/checkout@"))] |
    length == 1 and .[0].with.ref == "${{ needs.prepare.outputs.head-sha }}") and
  any(.jobs["prewarm-rust-cache"].steps[];
    ((.uses // "") | startswith("actions/download-artifact@")) and
    .with["artifact-ids"] == "${{ needs.prepare.outputs.cli-artifact-id }}") and
  .jobs.build.with["head-sha"] == .jobs["prewarm-rust-cache"].env.RUNNER_BINARY_GIT_REVISION and
  any(.architecture.jobs.compile.steps[];
    .run == ".github/scripts/runner/runner-binary-transport.sh publish" and
    .env.PRODUCER_HEAD_SHA == "${{ inputs.producer-head-sha }}"
  )
' <<<"$runner_json" >/dev/null || {
  echo 'Runner image build revision, producer identity, or CLI ordering is invalid' >&2
  exit 1
}

jq -e '
  [.jobs | to_entries[] | select(.key | startswith("runner-behavior-lane-"))] as $lanes |
  ($lanes | length) > 0 and
  all($lanes[];
    [.value.steps[] | select((.uses // "") | startswith("actions/checkout@"))] |
    length == 1 and (.[0].with.ref // "${{ github.sha }}") == "${{ github.sha }}"
  )
' <<<"$crates_json" >/dev/null || {
  echo 'Native behavior scripts must use the same event build revision as Runner image' >&2
  exit 1
}

jq -e '
  .jobs["prepare-runner-cli"] as $prepare |
  $prepare.steps as $steps |
  ($steps | map(.uses // "" | . == "./.github/actions/build-runner-cli") | index(true)) as $build |
  ($steps | map(((.uses // "") | startswith("actions/upload-artifact@")) and
    .with.name == "runner-release-cli-${{ github.run_id }}-${{ github.run_attempt }}") | index(true)) as $upload |
  $prepare.needs == "release-please" and
  $prepare.if == "${{ needs.release-please.outputs.runner_rs_release_created == \u0027true\u0027 }}" and
  ($build < $upload) and
  $steps[$build].with["source-sha"] == "${{ needs.release-please.outputs.release_target }}" and
  ($steps[$upload].with.path | split("\n") | index("runner-cli-intermediate/package.tgz") != null and index("runner-cli-intermediate/manifest.json") != null) and
  $steps[$upload].with.name == "runner-release-cli-${{ github.run_id }}-${{ github.run_attempt }}" and
  ($steps[$upload].with | has("overwrite") | not) and
  $steps[$upload].with["if-no-files-found"] == "error" and
  $steps[$upload].with["retention-days"] == 1 and
  (.jobs["build-runner-release-assets"].needs | index("prepare-runner-cli") != null) and
  any(.jobs["build-runner-release-assets"].steps[];
    ((.uses // "") | startswith("actions/download-artifact@")) and
    .with["artifact-ids"] == "${{ needs.prepare-runner-cli.outputs.artifact-id }}" and
    .with.path == "runner-cli-intermediate") and
  any(.jobs["build-runner-release-assets"].steps[];
    .env.GUEST_CLI_PATH == "${{ github.workspace }}/runner-cli-intermediate/package.tgz" and
    .env.GUEST_CLI_MANIFEST_PATH == "${{ github.workspace }}/runner-cli-intermediate/manifest.json") and
  (.jobs["builds-complete"].needs | index("prepare-runner-cli") != null) and
  (.jobs["build-runner-production"].needs | index("build-runner-release-assets") != null) and
  any(.jobs["build-runner-production"].steps[];
    .env.RUNNER_TARGET == "${{ matrix.target }}" and
    .env.RUNNER_VERSION == "${{ needs.release-please.outputs.runner_rs_version }}" and
    (.run | contains("playbooks/build-runner.yml"))
  )
' <<<"$release_json" >/dev/null || {
  echo 'Release CLI producer/consumer ordering is invalid' >&2
  exit 1
}

echo 'embedded-cli-workflow-test: ok'
