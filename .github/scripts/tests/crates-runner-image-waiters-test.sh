#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
repo_root="$(cd "$repo_root/.." && pwd)"

ruby -ryaml -rjson -ropen3 -rtmpdir -rfileutils - "$repo_root" <<'RUBY'
root = ARGV.fetch(0)
workflow = YAML.load_file(File.join(root, ".github/workflows/crates.yml"))
jobs = workflow.fetch("jobs")
groups = jobs.fetch("runner-host-groups")
selected = jobs.fetch("runner-test-prepare")
gate = jobs.fetch("ci-gate-crates")
group_step = groups.fetch("steps").find { |step| step["id"] == "groups" }
select_step = selected.fetch("steps").find { |step| step["id"] == "selected-host" }
gate_step = gate.fetch("steps").find { |step| step["name"] == "Validate CI results" }

unless selected.fetch("needs") == ["detect", "runner-host-groups"]
  raise "selected image preparation must follow host selection"
end
%w[nbd-cow-test runner-rootfs-process-test].each do |name|
  unless jobs.fetch(name).dig("strategy", "matrix", "include").include?("needs.runner-host-groups.outputs.matrix")
    raise "#{name} must retain the full architecture matrix"
  end
end
%w[runner-behavior-lane-a runner-behavior-lane-b runner-behavior-lane-c runner-behavior-lane-d].each do |name|
  raise "#{name} must depend only on selected target readiness" unless jobs.fetch(name).fetch("needs") == ["runner-test-prepare"]
end
%w[host-cpu-fairness-build].each do |name|
  build = jobs.fetch(name)
  unless build.fetch("needs") == ["detect", "runner-host-groups"] &&
      build.dig("env", "TARGET_TRIPLE") == '${{ needs.runner-host-groups.outputs.selected-target }}'
    raise "#{name} must compile for the planned target without waiting for an image"
  end
end
fs_build = jobs.fetch("guest-rpc-firecracker-build")
fs_test = jobs.fetch("guest-rpc-firecracker-test")
unless fs_build.fetch("needs") == ["detect", "runner-host-groups"] &&
    fs_build.dig("env", "TARGET_TRIPLE") == '${{ matrix.target }}' &&
    fs_build.dig("strategy", "matrix", "include").include?("needs.runner-host-groups.outputs.matrix") &&
    fs_test.dig("strategy", "matrix", "include") == fs_build.dig("strategy", "matrix", "include")
  raise "filesystem compilation and execution must cover the same full architecture matrix"
end
unless %w[detect runner-host-groups runner-test-prepare guest-rpc-firecracker-build].all? { |owner| fs_test.fetch("needs").include?(owner) }
  raise "filesystem acceptance must wait for its binary and image preparation"
end
fs_manifest = fs_test.fetch("steps").find { |step| step["id"] == "manifest" }
unless fs_manifest.dig("env", "TARGET") == fs_test.dig("env", "TARGET_TRIPLE") &&
    fs_manifest.dig("env", "SELECTED_HOST") == '${{ steps.selected-host.outputs.host }}' &&
    fs_manifest.fetch("run") == ".github/scripts/runner/wait-runner-image.sh"
  raise "each filesystem consumer must validate its matching host and manifest"
end
fs_pair = fs_build.fetch("steps").find { |step| step["env"]&.key?("NATIVE_MATRIX") }
unless group_step.dig("env", "SELECTION_KEY") == '${{ needs.detect.outputs.runner-image-job-ref }}' &&
    select_step.dig("env", "EXPECTED_TARGET") == '${{ needs.runner-host-groups.outputs.selected-target }}' &&
    gate_step.dig("env", "RUNNER_IMAGE_NEEDED") == "${{ needs.detect.outputs.metal-job-ref != '' && needs.detect.outputs.crates-runner-consumer-needed == 'true' }}"
  raise "planning, validation, and gate must share the original image selection context"
end

def run_step(root, env, step, success: true)
  output, error, status = Open3.capture3(env, "bash", "-euo", "pipefail", "-c", step, chdir: root)
  raise "unexpected step status #{status.exitstatus}: #{output}#{error}" unless status.success? == success
  output + error
end

def check_gate(root, gate, step, needed: "true", cpu_needed: "true", release: "false", results: {}, success: true)
  values = gate.fetch("needs").to_h { |name| [name, "success"] }.merge(results)
  script = step.fetch("run").gsub(/\$\{\{ needs\.([a-z-]+)\.result \}\}/) { values.fetch(Regexp.last_match(1)) }
  raise "unresolved gate expression" if script.include?("${{")
  env = {"IS_RELEASE" => release, "RUNNER_IMAGE_NEEDED" => needed,
         "CHECKS_NEEDED" => "true", "CI_CHANGED" => "true",
         "GUEST_CONTROL_CHANGED" => "false", "ABLY_CHANGED" => "false",
         "COVERAGE_NEEDED" => "true", "FIREWALL_CONTRACT_NEEDED" => "false",
         "NATIVE_KERBEROS_NEEDED" => "true", "NATIVE_GSSAPI_PEER_NEEDED" => "true",
         "GUEST_HOME_CLEANUP_NEEDED" => "true",
         "CPU_FAIRNESS_NEEDED" => cpu_needed}
  run_step(root, env, script, success: success)
end

target = File.join(root, "crates/target")
raise "test target must not be a symlink" if File.symlink?(target)
FileUtils.mkdir_p(target)
raise "test target must be canonical" unless File.realpath(target) == target
Dir.mktmpdir("crates-image-waiters", target) do |dir|
  bin = File.join(dir, "bin")
  FileUtils.mkdir_p(bin)
  ssh = File.join(bin, "ssh")
  File.write(ssh, <<~SH)
    #!/usr/bin/env bash
    set -euo pipefail
    [ "$1" = "-n" ]
    case "$2" in
      ci@arm-*) echo aarch64 ;;
      ci@x86-*) echo x86_64 ;;
      *) exit 1 ;;
    esac
  SH
  File.chmod(0o755, ssh)

  ["arm-1,x86-1,x86-2", "arm-1", "x86-1"].each do |hosts|
    %w[pr-1 pr-2].each do |key|
      output_file = File.join(dir, "#{hosts}-#{key}.out")
      env = {"PATH" => "#{bin}:#{ENV.fetch('PATH')}", "METAL_USER" => "ci",
             "AWS_METAL_RUNNER_HOSTS" => hosts, "RUNNER_CONSUMER_NEEDED" => "true",
             "SELECTION_KEY" => key, "GITHUB_OUTPUT" => output_file}
      run_step(root, env, group_step.fetch("run"))
      outputs = File.readlines(output_file, chomp: true).to_h { |line| line.split("=", 2) }
      full = JSON.parse(outputs.fetch("matrix"))
      target = outputs.fetch("selected-target")
      run_step(root, {"NATIVE_MATRIX" => JSON.generate(full)}, fs_pair.fetch("run"), success: full.length == 2)
      raise "one selected target must be covered by runner-test-prepare" unless full.count { |entry| entry.fetch("target") == target } == 1
      env["EXPECTED_TARGET"] = target
      env["GITHUB_OUTPUT"] = File.join(dir, "selected.out")
      run_step(root, env, select_step.fetch("run"))
      mismatch = run_step(root, env.merge("EXPECTED_TARGET" => "different-target"), select_step.fetch("run"), success: false)
      raise "inventory drift must report target mismatch" unless mismatch.include?("Selected runner target changed")
      check_gate(root, gate, gate_step)
    end
  end

  # Host-only tests still receive the complete matrix without image selection.
  output_file = File.join(dir, "host-only.out")
  env = {"PATH" => "#{bin}:#{ENV.fetch('PATH')}", "METAL_USER" => "ci",
         "AWS_METAL_RUNNER_HOSTS" => "arm-1,x86-1", "RUNNER_CONSUMER_NEEDED" => "false",
         "SELECTION_KEY" => "", "GITHUB_OUTPUT" => output_file}
  run_step(root, env, group_step.fetch("run"))
  outputs = File.readlines(output_file, chomp: true).to_h { |line| line.split("=", 2) }
  raise "host-only tests need both targets" unless JSON.parse(outputs.fetch("matrix")).length == 2
end

%w[runner-host-groups runner-test-prepare
   host-cpu-fairness-build host-cpu-fairness-test
   guest-rpc-firecracker-build guest-rpc-firecracker-test].each do |job|
  %w[failure cancelled skipped].each do |result|
    check_gate(root, gate, gate_step, results: {job => result}, success: false)
  end
end
# A failed producer skips its dependent execution job. Neither may disappear
# behind an otherwise green image waiter or the gate's optional-job handling.
{"host-cpu-fairness-build" => "host-cpu-fairness-test",
 "guest-rpc-firecracker-build" => "guest-rpc-firecracker-test"}.each do |build, execution|
  check_gate(root, gate, gate_step, results: {build => "failure", execution => "skipped"}, success: false)
end
optional_cpu = %w[host-cpu-fairness-build host-cpu-fairness-test].to_h { |name| [name, "skipped"] }
check_gate(root, gate, gate_step, cpu_needed: "false", results: optional_cpu)
unselected = %w[runner-host-groups runner-test-prepare
                host-cpu-fairness-build host-cpu-fairness-test
                guest-rpc-firecracker-build guest-rpc-firecracker-test].to_h { |name| [name, "skipped"] }
check_gate(root, gate, gate_step, needed: "false", cpu_needed: "false", results: unselected)
release_results = gate.fetch("needs").to_h { |name| [name, "skipped"] }.merge("detect-release" => "success")
check_gate(root, gate, gate_step, release: "true", results: release_results)

puts "crates-runner-image-waiters-test: ok"
RUBY
