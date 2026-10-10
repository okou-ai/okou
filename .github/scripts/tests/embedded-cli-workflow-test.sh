#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
runner_json=$(ruby -ryaml -rjson -e 'puts JSON.generate(YAML.load_file(ARGV.fetch(0)))' \
  "${REPO_ROOT}/.github/workflows/runner-image.yml")
release_json=$(ruby -ryaml -rjson -e 'puts JSON.generate(YAML.load_file(ARGV.fetch(0)))' \
  "${REPO_ROOT}/.github/workflows/release-please.yml")
crates_json=$(ruby -ryaml -rjson -e 'puts JSON.generate(YAML.load_file(ARGV.fetch(0)))' \
  "${REPO_ROOT}/.github/workflows/crates.yml")

jq -e '
  . as $root |
  .jobs.prepare.steps as $steps |
  ($steps | map(.name // "") | index("Checkout source revision for CLI and Runner")) as $checkout |
  ($steps | map(.name // "") | index("Build private source-bound CLI bundle")) as $build |
  ($steps | map(.name // "") | index("Upload private CLI build input")) as $upload |
  ($steps | map(.name // "") | index("Plan runner binary reuse")) as $plan |
  ($checkout < $build and $build < $upload and $upload < $plan) and
  .jobs.prepare.outputs["head-sha"] == "${{ steps.identity.outputs.head-sha }}" and
  .jobs.prepare.outputs["producer-head-sha"] == "${{ steps.identity.outputs.producer-head-sha }}" and
  any($steps[];
    .id == "identity" and
    .env.HEAD_SHA == "${{ github.sha }}" and
    .env.PRODUCER_HEAD_SHA == "${{ github.event.pull_request.head.sha || github.sha }}"
  ) and
  $steps[$checkout].with.ref == "${{ steps.identity.outputs.head-sha }}" and
  $steps[$build].env.SOURCE_SHA == "${{ steps.identity.outputs.head-sha }}" and
  ($steps[$build].run | contains("test \"$(git rev-parse HEAD)\" = \"$SOURCE_SHA\"")) and
  ($steps[$build].run | contains("build-okou-cli-artifact.sh")) and
  ($steps[$upload].with.path | split("\n") | index("runner-cli-intermediate/package.tgz") != null and index("runner-cli-intermediate/manifest.json") != null) and
  $steps[$upload].with.name == "runner-cli-${{ github.run_id }}" and
  $steps[$upload].with.overwrite == true and
  $steps[$plan].env.GUEST_CLI_PATH == "runner-cli-intermediate/package.tgz" and
  $steps[$plan].env.GUEST_CLI_MANIFEST_PATH == "runner-cli-intermediate/manifest.json" and
  $steps[$plan].env.RUNNER_BINARY_GIT_REVISION == "${{ steps.identity.outputs.head-sha }}" and
  (["compile", "build", "prewarm-rust-cache"] | all(.[]; . as $job |
    $root.jobs[$job].env.GUEST_CLI_PATH == "runner-cli-intermediate/package.tgz" and
    $root.jobs[$job].env.GUEST_CLI_MANIFEST_PATH == "runner-cli-intermediate/manifest.json" and
    $root.jobs[$job].env.RUNNER_BINARY_GIT_REVISION == "${{ needs.prepare.outputs.head-sha }}" and
    ([$root.jobs[$job].steps[] | select((.uses // "") | startswith("actions/checkout@"))] |
      length == 1 and .[0].with.ref == "${{ needs.prepare.outputs.head-sha }}") and
    any($root.jobs[$job].steps[];
      .name == "Download private CLI build input" and
      .with.name == $steps[$upload].with.name)
  )) and
  any(.jobs.compile.steps[];
    .run == ".github/scripts/runner-binary-transport.sh publish" and
    .env.PRODUCER_HEAD_SHA == "${{ needs.prepare.outputs.producer-head-sha }}"
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
  .jobs["publish-cli-versioned-artifact"] as $publisher |
  $publisher.steps as $steps |
  ($steps | map(.name // "") | index("Publish versioned CLI artifact")) as $publish |
  ($steps | map(.name // "") | index("Upload canonical CLI build input for Runner")) as $upload |
  $publisher.needs == "release-please" and
  ($publish < $upload) and
  $steps[$publish].env.ARTIFACT_SHA == "${{ needs.release-please.outputs.release_target }}" and
  $steps[$publish].env.OUTPUT_DIR == "runner-cli-intermediate" and
  $steps[$publish].run == "bash .github/scripts/publish-okou-cli-versioned-artifact.sh" and
  $steps[$upload].if == "${{ needs.release-please.outputs.runner_rs_release_created == \u0027true\u0027 }}" and
  ($steps[$upload].with.path | split("\n") | index("runner-cli-intermediate/package.tgz") != null and index("runner-cli-intermediate/manifest.json") != null) and
  $steps[$upload].with.name == "runner-release-cli-${{ github.run_id }}" and
  $steps[$upload].with.overwrite == true and
  $steps[$upload].with["if-no-files-found"] == "error" and
  $steps[$upload].with["retention-days"] == 1 and
  (.jobs["build-runner-release-assets"].needs | index("publish-cli-versioned-artifact") != null) and
  any(.jobs["build-runner-release-assets"].steps[];
    .name == "Download canonical CLI build input" and
    .with.name == $steps[$upload].with.name and
    .with.path == $steps[$publish].env.OUTPUT_DIR) and
  any(.jobs["build-runner-release-assets"].steps[];
    .name == "Cross-compile runner with embedded guests and CLI for ${{ matrix.target }}" and
    .env.GUEST_CLI_PATH == "${{ github.workspace }}/runner-cli-intermediate/package.tgz" and
    .env.GUEST_CLI_MANIFEST_PATH == "${{ github.workspace }}/runner-cli-intermediate/manifest.json") and
  (.jobs["builds-complete"].needs | index("publish-cli-versioned-artifact") != null) and
  (.jobs["build-runner-production"].needs | index("build-runner-release-assets") != null) and
  any(.jobs["build-runner-production"].steps[];
    .name == "Build rootfs and snapshot on production hosts" and
    .env.RUNNER_TARGET == "${{ matrix.target }}" and
    .env.RUNNER_VERSION == "${{ needs.release-please.outputs.runner_rs_version }}" and
    (.run | contains("playbooks/build-runner.yml"))
  )
' <<<"$release_json" >/dev/null || {
  echo 'Release CLI producer/consumer ordering is invalid' >&2
  exit 1
}

echo 'embedded-cli-workflow-test: ok'
