#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
ruby -rjson -ropen3 -rtmpdir -rfileutils -ryaml - "$repo_root" <<'RUBY'
root = ARGV.fetch(0)
helper = File.join(root, ".github/scripts/runner-native-test-artifact.sh")

def run_helper(helper, env, operation, success: true)
  output, error, status = Open3.capture3(env, "bash", helper, operation)
  raise "unexpected #{operation} status #{status.exitstatus}: #{output}#{error}" unless status.success? == success
end

Dir.mktmpdir("native-test-artifact") do |dir|
  bin = File.join(dir, "bin")
  FileUtils.mkdir_p(bin)
  File.write(File.join(bin, "cargo"), <<~'SH')
    #!/usr/bin/env bash
    set -euo pipefail
    case "$TEST_NAME" in
      host_cpu_fairness) profile='--release' ;;
      guest_rpc) profile='--profile ci' ;;
      *) exit 91 ;;
    esac
    [ "$*" = "test --no-run $profile --target $TARGET_TRIPLE -p sandbox-firecracker --test $TEST_NAME --message-format=json-render-diagnostics" ]
    [ "${PWD##*/}" = crates ]
    # This dependency and a null executable must never be selected.
    jq -nc '{reason:"compiler-artifact",target:{name:"dependency",kind:["lib"]},profile:{test:false},executable:"wrong-file"}'
    jq -nc --arg test "$TEST_NAME" '{reason:"compiler-artifact",target:{name:$test,kind:["test"]},profile:{test:true},executable:null}'
    case "${CARGO_CASE:-success}" in
      missing) exit 0 ;;
      failed) exit 42 ;;
    esac
    jq -nc --arg test "$TEST_NAME" --arg path "$FAKE_TEST_BIN" \
      '{reason:"compiler-artifact",target:{name:$test,kind:["test"]},profile:{test:true},executable:$path}'
    if [ "${CARGO_CASE:-success}" = duplicate ]; then
      jq -nc --arg test "$TEST_NAME" --arg path "$FAKE_TEST_BIN" \
        '{reason:"compiler-artifact",target:{name:$test,kind:["test"]},profile:{test:true},executable:$path}'
    fi
  SH
  File.chmod(0o755, File.join(bin, "cargo"))
  fake_test = File.join(dir, "compiled-test")
  File.write(fake_test, "compiled integration test fixture\n")
  File.chmod(0o755, fake_test)
  env = {"PATH" => "#{bin}:#{ENV.fetch('PATH')}", "FAKE_TEST_BIN" => fake_test,
         "GITHUB_REPOSITORY" => "test/repository", "GITHUB_SHA" => "a" * 40,
         "GITHUB_RUN_ID" => "123", "PRODUCER_ATTEMPT" => "1", "GITHUB_RUN_ATTEMPT" => "1",
         "GITHUB_OUTPUT" => File.join(dir, "output"), "GITHUB_ENV" => File.join(dir, "env")}
  %w[aarch64-unknown-linux-musl x86_64-unknown-linux-musl].each do |target|
    %w[host_cpu_fairness guest_rpc].each do |name|
      built = File.join(dir, "#{target}-#{name}")
      inputs = env.merge("TARGET_TRIPLE" => target, "TEST_NAME" => name, "ARTIFACT_DIR" => built)
      run_helper(helper, inputs, "build")
      raise "producer attempt missing" unless File.read(env.fetch("GITHUB_OUTPUT")).include?("producer-attempt=1\n")
      raise "wrong executable selected" unless File.read(File.join(built, "test-bin")) == File.read(fake_test)

      # Downloaded files lose executable mode; a failed-job-only rerun uses producer attempt 1.
      File.chmod(0o644, File.join(built, "test-bin"))
      run_helper(helper, inputs.merge("GITHUB_RUN_ATTEMPT" => "2"), "validate")
      raise "executable mode not restored" unless File.executable?(File.join(built, "test-bin"))
      raise "validated path not exported" unless File.read(env.fetch("GITHUB_ENV")).include?("TEST_BIN=#{built}/test-bin\n")

      mutations = {
        "repository" => "other/repository", "sha" => "b" * 40, "run" => "456", "attempt" => "2",
        "target" => target.start_with?("aarch64") ? "x86_64-unknown-linux-musl" : "aarch64-unknown-linux-musl",
        "test" => name == "guest_rpc" ? "host_cpu_fairness" : "guest_rpc",
        "profile" => name == "guest_rpc" ? "release" : "ci", "sha256" => "0" * 64, "version" => 2
      }
      (mutations.keys + %w[corrupt missing-manifest missing-binary symlink-binary producer-output]).each do |bad|
        downloaded = File.join(dir, "download")
        FileUtils.cp_r(built, downloaded)
        path = File.join(downloaded, "test-bin")
        File.chmod(0o644, path)
        File.write(env.fetch("GITHUB_ENV"), "")
        manifest_path = File.join(downloaded, "manifest.json")
        if mutations.key?(bad)
          manifest = JSON.parse(File.read(manifest_path))
          manifest[bad] = mutations.fetch(bad)
          File.write(manifest_path, JSON.generate(manifest))
        else
          case bad
          when "corrupt" then File.write(path, "corrupted payload")
          when "missing-manifest" then File.unlink(manifest_path)
          when "missing-binary" then File.unlink(path)
          when "symlink-binary"
            File.unlink(path)
            File.symlink(fake_test, path)
          end
        end
        invalid_inputs = inputs.merge("ARTIFACT_DIR" => downloaded)
        invalid_inputs["PRODUCER_ATTEMPT"] = "2" if bad == "producer-output"
        run_helper(helper, invalid_inputs, "validate", success: false)
        raise "invalid artifact exported: #{bad}" unless File.zero?(env.fetch("GITHUB_ENV"))
        FileUtils.rm_rf(downloaded)
      end

      %w[missing failed duplicate].each do |cargo_case|
        output = File.join(dir, "failed-build-#{cargo_case}")
        run_helper(helper, inputs.merge("ARTIFACT_DIR" => output, "CARGO_CASE" => cargo_case), "build", success: false)
        raise "failed build published a manifest" if File.exist?(File.join(output, "manifest.json"))
        FileUtils.rm_rf(output)
      end
      run_helper(helper, inputs, "build", success: false) # No stale directory reuse.
    end
  end

  jobs = YAML.load_file(File.join(root, ".github/workflows/crates.yml")).fetch("jobs")
  %w[host-cpu-fairness guest-rpc-firecracker].each do |prefix|
    producer = jobs.fetch("#{prefix}-build")
    consumer = jobs.fetch("#{prefix}-test")
    upload = producer.fetch("steps").find { |step| step["id"] == "upload" }
    download = consumer.fetch("steps").find { |step| step.fetch("uses", "").start_with?("actions/download-artifact@") }
    guard = consumer.fetch("steps").find { |step| step["name"] == "Require native test artifact ID" }
    raise "artifact upload must fail closed" unless upload.dig("with", "if-no-files-found") == "error"
    raise "producer must expose immutable artifact ID" unless producer.dig("outputs", "artifact-id") == '${{ steps.upload.outputs.artifact-id }}'
    expected_id = "${{ needs.#{prefix}-build.outputs.artifact-id }}"
    raise "consumer must download its exact producer" unless download.dig("with", "artifact-ids") == expected_id && guard.dig("env", "ARTIFACT_ID") == expected_id
    raise "consumer must retain producer attempt" unless consumer.dig("env", "PRODUCER_ATTEMPT") == "${{ needs.#{prefix}-build.outputs.producer-attempt }}"
    raise "download must stay in current run" if download.fetch("with").key?("run-id")
    raise "empty ID guard must precede download" unless consumer.fetch("steps").index(guard) < consumer.fetch("steps").index(download)
    ["", "0", "1,2", "../123", "123"].each do |id|
      _, _, status = Open3.capture3({"ARTIFACT_ID" => id}, "bash", "-e", "-c", guard.fetch("run"))
      raise "invalid artifact ID acceptance: #{id}" unless status.success? == (id == "123")
    end
  end
end
puts "runner-native-test-artifact-test: ok"
RUBY
