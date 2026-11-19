#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
CRATES_WORKFLOW="${REPO_ROOT}/.github/workflows/crates.yml"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

command -v yq >/dev/null || fail "yq is required"
crates_json=$(yq -o=json '.' "$CRATES_WORKFLOW")

jq -e '
  .jobs.detect as $detect |
  .jobs.check as $check |
  .jobs["api-contracts-rust-bindings"] as $bindings |
  .jobs["runner-behavior-lane-a"] as $lane_a |
  .jobs["runner-behavior-lane-b"] as $lane_b |
  .jobs["runner-behavior-lane-c"] as $lane_c |
  .jobs["runner-behavior-lane-d"] as $lane_d |
  .jobs["host-cpu-fairness-build"] as $host_cpu_build |
  .jobs["host-cpu-fairness-test"] as $host_cpu |
  .jobs["runner-rootfs-process-test"] as $rootfs_process |
  .jobs["ci-gate-crates"] as $gate |
  {
    "any-changed": "${{ steps.detect.outputs.any-changed }}",
    "ci-changed": "${{ steps.detect.outputs.ci-changed }}",
    "coverage-needed": "${{ steps.detect.outputs.coverage-needed }}",
    "native-kerberos-needed": "${{ steps.detect.outputs.native-kerberos-needed }}",
    "native-gssapi-peer-needed": "${{ steps.detect.outputs.native-gssapi-peer-needed }}",
    "guest-home-cleanup-needed": "${{ steps.detect.outputs.guest-home-cleanup-needed }}",
    "mitm-addon-test-inputs-changed": "${{ steps.detect.outputs.mitm-addon-test-inputs-changed }}",
    "mitm-addon-pricing-seed-changed": "${{ steps.detect.outputs.mitm-addon-pricing-seed-changed }}",
    "runner-firewall-contract-inputs-changed": "${{ steps.detect.outputs.runner-firewall-contract-inputs-changed }}",
    "api-contracts-rust-bindings-changed": "${{ steps.detect.outputs.api-contracts-rust-bindings-changed }}",
    "ably-subscriber-changed": "${{ steps.detect.outputs.ably-subscriber-changed }}",
    "api-contracts-changed": "${{ steps.detect.outputs.api-contracts-changed }}",
    "runner-changed": "${{ steps.detect.outputs.runner-changed }}",
    "sandbox-firecracker-changed": "${{ steps.detect.outputs.sandbox-firecracker-changed }}",
    "nbd-cow-changed": "${{ steps.detect.outputs.nbd-cow-changed }}",
    "guest-control-tests-changed": "${{ steps.detect.outputs.guest-control-tests-changed }}",
    "crates-runner-consumer-needed": "${{ steps.runner-tests.outputs.crates-runner-consumer-needed }}",
    "metal-job-ref": "${{ steps.runner-job-ref.outputs.job-ref }}",
    "runner-image-job-ref": "${{ steps.runner-job-ref.outputs.image-job-ref }}"
  } as $required_outputs |
  all($required_outputs | to_entries[]; $detect.outputs[.key] == .value) and
  any($detect.steps[]?;
    .id == "detect" and
    (.run // "" | contains(".github/scripts/checks/changed-base-ref.sh")) and
    (.run // "" | contains("./scripts/crate-changed.sh"))
  ) and
  any($detect.steps[]?;
    .id == "runner-tests" and
    .run == ".github/scripts/runner/runner-image-context.sh crates-consumer"
  ) and
  any($detect.steps[]?;
    .id == "runner-job-ref" and
    (.run // "" | contains("job-ref=${JOB_REF}")) and
    (.run // "" | contains("image-job-ref=${IMAGE_JOB_REF}"))
  ) and
  $bindings.container.image == $check.container.image and
  any($bindings.steps[]?;
    (.run // "" | contains("pnpm -F @okouai/api-contracts generate:rust")) and
    (.run // "" | contains("pnpm -F @okouai/api-contracts generate:python")) and
    (.run // "" | contains("git diff --exit-code"))
  ) and
  ($host_cpu.needs | sort) == ([
    "detect",
    "runner-test-prepare",
    "host-cpu-fairness-build"
  ] | sort) and
  $host_cpu_build.needs == ["detect", "runner-host-groups"] and
  $host_cpu_build.env.TARGET_TRIPLE == "${{ needs.runner-host-groups.outputs.selected-target }}" and
  $host_cpu_build.env.TEST_NAME == "host_cpu_fairness" and
  ($host_cpu_build.if | contains("needs.detect.outputs.sandbox-firecracker-changed")) and
  ($host_cpu_build.if | contains("needs.detect.outputs.ci-changed")) and
  ($host_cpu.if | contains("needs.runner-test-prepare.result")) and
  ($host_cpu.if | contains("needs.host-cpu-fairness-build.result")) and
  ($host_cpu.if | contains("needs.runner-behavior-lane-") | not) and
  ($host_cpu.if | contains("needs.detect.outputs.sandbox-firecracker-changed")) and
  ($host_cpu.if | contains("needs.detect.outputs.ci-changed")) and
  ([$lane_a, $lane_b, $lane_c, $lane_d] |
    all(.[]; .needs == ["runner-test-prepare"])) and
  $host_cpu.env.TARGET_TRIPLE == "${{ needs.runner-test-prepare.outputs.target }}" and
  $host_cpu.env.HOST_CPU_TEST_MODE == "placement" and
  any($host_cpu_build.steps[]?;
    .run == "bash .github/scripts/runner/runner-native-test-artifact.sh build"
  ) and
  any($host_cpu.steps[]?;
    .run == "crates/sandbox-firecracker/tests/native/runner-behavior-host-cpu-fairness.sh"
  ) and
  ($gate.needs | index("host-cpu-fairness-test")) != null and
  ($gate.needs | index("host-cpu-fairness-build")) != null and
  ($gate.needs | index("runner-behavior-lane-d")) != null and
  $rootfs_process.needs == ["detect", "runner-host-groups"] and
  $rootfs_process.defaults.run.shell == "bash" and
  ($rootfs_process.if | contains("needs.detect.outputs.runner-changed")) and
  ($rootfs_process.if | contains("needs.detect.outputs.ci-changed")) and
  any($rootfs_process.steps[]?;
    .uses == "./.github/actions/setup-r2-sccache" and
    .with.architecture == "${{ matrix.id }}"
  ) and
  any($rootfs_process.steps[]?;
    (.run // "" | contains("--profile local")) and
    (.run // "" | contains(".target.name == \"runner\" and .profile.test"))
  ) and
  any($rootfs_process.steps[]?;
    (.run // "" | contains("sudo unshare --mount --pid --fork --kill-child --mount-proc")) and
    (.run // "" | contains("--ignored --exact")) and
    (.run // "" | contains("cmd::build::scripts::process_tests::rootfs_process_ownership")) and
    (.run // "" | contains("GITHUB_RUN_ATTEMPT")) and
    (.run // "" | contains("runner-host-architecture-groups.sh"))
  ) and
  ($gate.needs | index("runner-rootfs-process-test")) != null and
  any($gate.steps[]?;
    (.run // "" | contains("needs.host-cpu-fairness-test.result")) and
    (.run // "" | contains("needs.runner-behavior-lane-d.result")) and
    (.run // "" | contains("needs.runner-rootfs-process-test.result"))
  )
' <<<"$crates_json" >/dev/null || fail "Crates workflow contract changed"

# Exercise the nbd handoff with Cargo's actual executable metadata and layout.
ruby -rjson -ropen3 -rtmpdir -rfileutils -ryaml - "$REPO_ROOT" <<'RUBY'
root = ARGV.fetch(0)
steps = YAML.load_file(File.join(root, ".github/workflows/crates.yml")).fetch("jobs").fetch("nbd-cow-test").fetch("steps")
compile = steps.find { |step| step.fetch("run", "").include?('target/nbd-cow-integration-test') }
raise "missing nbd compiler step" unless compile && compile["shell"] == "bash"
host, error, status = Open3.capture3("rustc", "-vV")
raise error unless status.success?
target = host.lines.find { |line| line.start_with?("host: ") }.delete_prefix("host: ").strip
Dir.mktmpdir("nbd-compiled-artifact") do |fixture|
  FileUtils.mkdir_p(File.join(fixture, "crates/tests"))
  FileUtils.cp(File.join(root, "rust-toolchain.toml"), fixture)
  File.write(File.join(fixture, "crates/Cargo.toml"), <<~TOML)
    [package]
    name = "nbd-cow"
    version = "0.0.0"
    edition = "2024"
    [workspace]
  TOML
  File.write(File.join(fixture, "crates/tests/integration.rs"), "#[test]\n#[ignore]\nfn compiled_nbd_fixture() {}\n")
  _, error, status = Open3.capture3("cargo", "generate-lockfile", "--offline", chdir: File.join(fixture, "crates"))
  raise error unless status.success?
  output_file = File.join(fixture, "environment")
  env = {"TARGET_TRIPLE" => target, "GITHUB_ENV" => output_file, "CARGO_TARGET_DIR" => nil}
  output, error, status = Open3.capture3(env, "bash", "-euo", "pipefail", "-c", compile.fetch("run"), chdir: fixture)
  raise "nbd artifact build failed: #{output}#{error}" unless status.success?
  exported = File.readlines(output_file, chomp: true).to_h { |line| line.split("=", 2) }
  executable = File.join(fixture, exported.fetch("TEST_BIN"))
  result, error, status = Open3.capture3(executable, "--ignored", "--exact", "compiled_nbd_fixture")
  raise "nbd artifact was not runnable: #{result}#{error}" unless status.success? && result.include?("1 passed; 0 failed;")
end
RUBY

echo "crates-detect-workflow-test: ok"
