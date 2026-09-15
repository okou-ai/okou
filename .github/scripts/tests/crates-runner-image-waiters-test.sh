#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
repo_root="$(cd "$repo_root/.." && pwd)"

ruby -ryaml -rjson -ropen3 -rtmpdir -rfileutils - "$repo_root" <<'RUBY'
root = ARGV.fetch(0)
workflow = YAML.load_file(File.join(root, ".github/workflows/crates.yml"))
jobs = workflow.fetch("jobs")
groups = jobs.fetch("runner-host-groups")
selected = jobs.fetch("runner-build")
remaining = jobs.fetch("runner-image-architecture-manifest")
gate = jobs.fetch("ci-gate-crates")
group_step = groups.fetch("steps").find { |step| step["id"] == "groups" }
select_step = selected.fetch("steps").find { |step| step["id"] == "selected-host" }
gate_step = gate.fetch("steps").find { |step| step["name"] == "Validate CI results" }

unless selected.fetch("needs") == ["detect", "runner-host-groups"] &&
    remaining.fetch("needs") == ["detect", "runner-host-groups"] &&
    remaining.dig("strategy", "fail-fast") == false &&
    remaining.dig("strategy", "matrix", "include") == '${{ fromJSON(needs.runner-host-groups.outputs.validation-matrix || \'[]\') }}' &&
    remaining.fetch("if").include?("needs.runner-host-groups.outputs.validation-matrix != '[]'")
  raise "selected and complementary validation must start independently, with empty complements omitted"
end
%w[nbd-cow-test runner-rootfs-process-test].each do |name|
  unless jobs.fetch(name).dig("strategy", "matrix", "include").include?("needs.runner-host-groups.outputs.matrix")
    raise "#{name} must retain the full architecture matrix"
  end
end
%w[runner-behavior-lane-a runner-behavior-lane-b runner-behavior-lane-c runner-behavior-lane-d guest-rpc-firecracker-test].each do |name|
  raise "#{name} must depend only on selected target readiness" unless jobs.fetch(name).fetch("needs") == ["runner-build"]
end
unless group_step.dig("env", "SELECTION_KEY") == '${{ needs.detect.outputs.runner-image-job-ref }}' &&
    select_step.dig("env", "EXPECTED_TARGET") == '${{ needs.runner-host-groups.outputs.selected-target }}' &&
    gate_step.dig("env", "IMAGE_VALIDATION_MATRIX") == '${{ needs.runner-host-groups.outputs.validation-matrix }}' &&
    gate_step.dig("env", "RUNNER_IMAGE_NEEDED") == "${{ needs.detect.outputs.metal-job-ref != '' && needs.detect.outputs.crates-runner-consumer-needed == 'true' }}"
  raise "planning, validation, and gate must share the original image selection context"
end

def run_step(root, env, step, success: true)
  output, error, status = Open3.capture3(env, "bash", "-euo", "pipefail", "-c", step, chdir: root)
  raise "unexpected step status #{status.exitstatus}: #{output}#{error}" unless status.success? == success
  output + error
end

def check_gate(root, gate, step, matrix:, needed: "true", release: "false", results: {}, success: true)
  values = gate.fetch("needs").to_h { |name| [name, "success"] }.merge(results)
  script = step.fetch("run").gsub(/\$\{\{ needs\.([a-z-]+)\.result \}\}/) { values.fetch(Regexp.last_match(1)) }
  raise "unresolved gate expression" if script.include?("${{")
  env = {"IS_RELEASE" => release, "RUNNER_IMAGE_NEEDED" => needed, "IMAGE_VALIDATION_MATRIX" => matrix}
  run_step(root, env, script, success: success)
end

Dir.mktmpdir("crates-image-waiters") do |dir|
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
      other = JSON.parse(outputs.fetch("validation-matrix"))
      target = outputs.fetch("selected-target")
      raise "image validation must partition the full matrix" unless other == full.reject { |entry| entry.fetch("target") == target }
      raise "one selected target must be covered by runner-build" unless full.count { |entry| entry.fetch("target") == target } == 1
      env["EXPECTED_TARGET"] = target
      env["GITHUB_OUTPUT"] = File.join(dir, "selected.out")
      run_step(root, env, select_step.fetch("run"))
      mismatch = run_step(root, env.merge("EXPECTED_TARGET" => "different-target"), select_step.fetch("run"), success: false)
      raise "inventory drift must report target mismatch" unless mismatch.include?("Selected runner target changed")
      matrix_result = other.empty? ? "skipped" : "success"
      check_gate(root, gate, gate_step, matrix: outputs.fetch("validation-matrix"), results: {"runner-image-architecture-manifest" => matrix_result})
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

%w[runner-host-groups runner-build runner-image-architecture-manifest].each do |job|
  %w[failure cancelled skipped].each do |result|
    check_gate(root, gate, gate_step, matrix: '[{"target":"other"}]', results: {job => result}, success: false)
  end
end
check_gate(root, gate, gate_step, matrix: "[]", results: {"runner-build" => "skipped", "runner-image-architecture-manifest" => "skipped"}, success: false)
check_gate(root, gate, gate_step, matrix: "", results: {"runner-image-architecture-manifest" => "skipped"}, success: false)
unselected = %w[runner-host-groups runner-build runner-image-architecture-manifest guest-rpc-firecracker-test].to_h { |name| [name, "skipped"] }
check_gate(root, gate, gate_step, matrix: "", needed: "false", results: unselected)
check_gate(root, gate, gate_step, matrix: "", release: "true", results: gate.fetch("needs").to_h { |name| [name, "skipped"] })

puts "crates-runner-image-waiters-test: ok"
RUBY
