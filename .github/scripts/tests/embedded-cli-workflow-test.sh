#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
runner_json=$(ruby -ryaml -rjson -e 'puts JSON.generate(YAML.load_file(ARGV.fetch(0)))' \
  "${REPO_ROOT}/.github/workflows/runner-image.yml")
release_json=$(ruby -ryaml -rjson -e 'puts JSON.generate(YAML.load_file(ARGV.fetch(0)))' \
  "${REPO_ROOT}/.github/workflows/release-please.yml")

jq -e '
  . as $root |
  .jobs.prepare.steps as $steps |
  ($steps | map(.name // "") | index("Checkout source revision for CLI and Runner")) as $checkout |
  ($steps | map(.name // "") | index("Build private source-bound CLI bundle")) as $build |
  ($steps | map(.name // "") | index("Upload private CLI build input")) as $upload |
  ($steps | map(.name // "") | index("Plan runner binary reuse")) as $plan |
  ($checkout < $build and $build < $upload and $upload < $plan) and
  $steps[$checkout].with.ref == "${{ steps.identity.outputs.source-head-sha }}" and
  ($steps[$build].run | contains("build-okou-cli-artifact.sh")) and
  $steps[$upload].with.path == "runner-cli-intermediate/package.tgz" and
  $steps[$plan].env.RUNNER_CLI_PACKAGE_PATH == "runner-cli-intermediate/package.tgz" and
  $steps[$plan].env.RUNNER_BINARY_GIT_REVISION == "${{ steps.identity.outputs.source-head-sha }}" and
  $steps[$plan].env.RUNNER_CLI_REQUIRED == "true" and
  .jobs.compile.env.RUNNER_CLI_REQUIRED == "true" and
  .jobs.compile.env.RUNNER_BINARY_GIT_REVISION == "${{ needs.prepare.outputs.source-head-sha }}" and
  (["compile", "build", "asset"] | all(.[]; . as $job |
    $root.jobs[$job].env.RUNNER_CLI_REQUIRED == "true" and
    $root.jobs[$job].env.RUNNER_CLI_PACKAGE_PATH == "runner-cli-intermediate/package.tgz" and
    $root.jobs[$job].env.RUNNER_BINARY_GIT_REVISION == "${{ needs.prepare.outputs.source-head-sha }}" and
    any($root.jobs[$job].steps[]; .name == "Download private CLI build input")
  ))
' <<<"$runner_json" >/dev/null || {
  echo 'Runner image CLI producer/consumer ordering is invalid' >&2
  exit 1
}

jq -e '
  .jobs["prepare-runner-cli"].needs == "release-please" and
  any(.jobs["prepare-runner-cli"].steps[]; .name == "Build source-bound CLI for Runner" and
    (.run | contains("build-okou-cli-artifact.sh"))) and
  any(.jobs["prepare-runner-cli"].steps[]; .name == "Upload private CLI build input" and
    .with.path == "runner-cli-intermediate/package.tgz") and
  (.jobs["build-runner-release-assets"].needs | index("prepare-runner-cli") != null) and
  any(.jobs["build-runner-release-assets"].steps[];
    .name == "Download source-bound CLI build input") and
  any(.jobs["build-runner-release-assets"].steps[];
    .name == "Cross-compile runner with embedded guests and CLI for ${{ matrix.target }}" and
    .env.RUNNER_CLI_REQUIRED == "true" and
    .env.RUNNER_CLI_PACKAGE_PATH == "${{ github.workspace }}/runner-cli-intermediate/package.tgz") and
  (.jobs["builds-complete"].needs | index("prepare-runner-cli") != null)
' <<<"$release_json" >/dev/null || {
  echo 'Release CLI producer/consumer ordering is invalid' >&2
  exit 1
}

echo 'embedded-cli-workflow-test: ok'
