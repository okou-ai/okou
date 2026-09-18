#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
ruby -rjson -ropen3 -rtmpdir -rfileutils -ryaml - "$repo_root" <<'RUBY'
root = ARGV.fetch(0)
helper = File.join(root, ".github/scripts/runner-native-test-artifact.sh")

def run_helper(helper, env, operation, success: true)
  output, error, status = Open3.capture3(env, "bash", helper, operation)
  raise "unexpected #{operation} status #{status.exitstatus}: #{output}#{error}" unless status.success? == success
  output + error
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
  File.write(File.join(bin, "aws"), <<~'AWS')
    #!/usr/bin/env ruby
    require "json"
    require "fileutils"
    raise "expected s3api" unless ARGV.shift == "s3api"
    operation = ARGV.shift
    options = {}
    while ARGV.first&.start_with?("--")
      options[ARGV.shift] = ARGV.shift
    end
    key = options.fetch("--key")
    object = File.join(ENV.fetch("AWS_STORE"), key)
    File.open(ENV.fetch("AWS_LOG"), "a") { |f| f.puts(JSON.generate([operation, key])) }
    failure = ENV["AWS_FAIL"]
    if (operation == "put-object" && failure == (key.end_with?(".json") ? "manifest" : "binary")) ||
        (operation == "get-object" && failure == "get")
      warn JSON.generate({Error: {Code: "AccessDenied", Message: "fixture-sensitive-signature"}})
      exit 1
    end
    case operation
    when "put-object"
      FileUtils.mkdir_p(File.dirname(object))
      FileUtils.cp(options.fetch("--body"), object)
    when "get-object"
      unless File.file?(object)
        warn JSON.generate({Error: {Code: "NoSuchKey"}})
        exit 1
      end
      limit = Integer(options.fetch("--range").delete_prefix("bytes=0-")) + 1
      File.binwrite(ARGV.fetch(0), File.binread(object, limit))
    else
      raise "transport must not list or search for another run: #{operation}"
    end
  AWS
  File.chmod(0o755, File.join(bin, "aws"))
  fake_test = File.join(dir, "compiled-test")
  File.write(fake_test, "compiled integration test fixture\n")
  File.chmod(0o755, fake_test)
  env = {"PATH" => "#{bin}:#{ENV.fetch('PATH')}", "FAKE_TEST_BIN" => fake_test,
         "GITHUB_REPOSITORY" => "test/repository", "GITHUB_SHA" => "a" * 40,
         "GITHUB_RUN_ID" => "123", "PRODUCER_ATTEMPT" => "1", "GITHUB_RUN_ATTEMPT" => "1",
         "GITHUB_OUTPUT" => File.join(dir, "output"), "GITHUB_ENV" => File.join(dir, "env"),
         "AWS_ACCESS_KEY_ID" => "fixture-key", "AWS_SECRET_ACCESS_KEY" => "fixture-secret",
         "R2_ACCOUNT_ID" => "fixture-account", "R2_BUCKET_NAME" => "fixture-bucket",
         "AWS_STORE" => File.join(dir, "store"), "AWS_LOG" => File.join(dir, "aws-log")}
  %w[aarch64-unknown-linux-musl x86_64-unknown-linux-musl].each do |target|
    %w[host_cpu_fairness guest_rpc].each do |name|
      built = File.join(dir, "#{target}-#{name}")
      inputs = env.merge("TARGET_TRIPLE" => target, "TEST_NAME" => name, "ARTIFACT_DIR" => built)
      run_helper(helper, inputs, "build")
      raise "producer attempt missing" unless File.read(env.fetch("GITHUB_OUTPUT")).include?("producer-attempt=1\n")
      raise "wrong executable selected" unless File.read(File.join(built, "test-bin")) == File.read(fake_test)

      # Only this producer's exact run/attempt objects are published and fetched.
      key = "runner-binaries/#{target}/123/1/#{name}"
      File.write(env.fetch("AWS_LOG"), "")
      run_helper(helper, inputs, "publish")
      uploaded = File.readlines(env.fetch("AWS_LOG")).map { |line| JSON.parse(line) }
      raise "readiness published before binary" unless uploaded == [["put-object", "#{key}.zst"], ["put-object", "#{key}.json"]]
      received = File.join(dir, "received")
      consumer = inputs.merge("ARTIFACT_DIR" => received, "GITHUB_RUN_ATTEMPT" => "2")
      invalid_envs = [{"GITHUB_RUN_ID" => "../123"}, {"PRODUCER_ATTEMPT" => ""},
                      {"TEST_NAME" => "../test"}, {"TARGET_TRIPLE" => "unsupported"},
                      {"AWS_SECRET_ACCESS_KEY" => ""}]
      invalid_envs.each do |invalid|
        before = File.read(env.fetch("AWS_LOG"))
        run_helper(helper, consumer.merge(invalid), "download", success: false)
        raise "invalid inputs contacted R2" unless File.read(env.fetch("AWS_LOG")) == before
        raise "invalid inputs exposed an artifact" if File.exist?(received)
      end
      run_helper(helper, consumer, "download")
      raise "unvalidated download is executable" if File.executable?(File.join(received, "test-bin"))
      run_helper(helper, consumer, "validate")
      raise "R2 transfer changed the executable" unless File.binread(File.join(received, "test-bin")) == File.binread(fake_test)
      raise "executable mode not restored" unless File.executable?(File.join(received, "test-bin"))
      raise "validated path not exported" unless File.read(env.fetch("GITHUB_ENV")).include?("TEST_BIN=#{received}/test-bin\n")
      FileUtils.rm_rf(received)

      # Different runs and producer attempts cannot fall back to existing objects.
      [{"GITHUB_RUN_ID" => "124"}, {"PRODUCER_ATTEMPT" => "2"}].each do |identity|
        run_helper(helper, consumer.merge(identity), "download", success: false)
        raise "failed download exposed a directory" if File.exist?(received)
      end
      # A later producer does not overwrite the earlier successful attempt.
      rerun = File.join(dir, "rerun")
      rerun_inputs = inputs.merge("ARTIFACT_DIR" => rerun, "PRODUCER_ATTEMPT" => "2")
      run_helper(helper, rerun_inputs, "build")
      run_helper(helper, rerun_inputs, "publish")
      run_helper(helper, consumer, "download")
      raise "consumer fetched newer producer" unless JSON.parse(File.read(File.join(received, "manifest.json"))).fetch("attempt") == "1"
      FileUtils.rm_rf([received, rerun])

      remote_manifest = File.join(env.fetch("AWS_STORE"), "#{key}.json")
      remote_binary = File.join(env.fetch("AWS_STORE"), "#{key}.zst")
      valid_manifest = File.binread(remote_manifest)
      valid_binary = File.binread(remote_binary)
      %w[missing-manifest missing-binary malformed-manifest oversized-manifest wrong-sha wrong-attempt
         wrong-test wrong-target wrong-profile raw-size compressed-size truncated-binary corrupt-binary get-failed].each do |bad|
        manifest = JSON.parse(valid_manifest)
        case bad
        when "missing-manifest" then File.unlink(remote_manifest)
        when "missing-binary" then File.unlink(remote_binary)
        when "malformed-manifest" then File.write(remote_manifest, "invalid JSON")
        when "oversized-manifest" then File.write(remote_manifest, " " * 65537)
        when "wrong-sha" then manifest["sha"] = "b" * 40
        when "wrong-attempt" then manifest["attempt"] = "2"
        when "wrong-test" then manifest["test"] = "other_test"
        when "wrong-target" then manifest["target"] = "other_target"
        when "wrong-profile" then manifest["profile"] = "other_profile"
        when "raw-size" then manifest["sizeBytes"] = 134217729
        when "compressed-size" then manifest["compressedSizeBytes"] = 67108865
        when "truncated-binary" then File.binwrite(remote_binary, valid_binary[0, 8])
        when "corrupt-binary"
          payload, _, status = Open3.capture3("zstd", "-q", "-c", stdin_data: "\0" * File.size(fake_test))
          raise "fixture compression failed" unless status.success?
          File.binwrite(remote_binary, payload)
          manifest["compressedSizeBytes"] = payload.bytesize
        end
        File.write(remote_manifest, JSON.generate(manifest)) unless manifest == JSON.parse(valid_manifest)
        failed_env = consumer.merge("AWS_FAIL" => bad == "get-failed" ? "get" : "")
        output = run_helper(helper, failed_env, "download", success: false)
        raise "provider diagnostics leaked" if output.include?("fixture-sensitive-signature")
        raise "failed download exposed a directory: #{bad}" if File.exist?(received)
        File.binwrite(remote_manifest, valid_manifest)
        File.binwrite(remote_binary, valid_binary)
      end

      if target == "x86_64-unknown-linux-musl" && name == "guest_rpc"
        # Exercise the decoded-byte bound with a tiny compressed, oversized payload.
        oversized = File.join(dir, "oversized")
        File.open(oversized, "w") { |file| file.truncate(134217729) }
        payload, _, status = Open3.capture3("zstd", "-q", "-c", oversized)
        raise "fixture compression failed" unless status.success?
        File.unlink(oversized)
        File.binwrite(remote_binary, payload)
        manifest = JSON.parse(valid_manifest).merge("compressedSizeBytes" => payload.bytesize)
        File.write(remote_manifest, JSON.generate(manifest))
        run_helper(helper, consumer, "download", success: false)
        raise "oversized binary exposed an artifact" if File.exist?(received)
        File.binwrite(remote_manifest, valid_manifest)
        File.binwrite(remote_binary, valid_binary)
      end

      %w[binary manifest].each do |stage|
        failed_build = File.join(dir, "failed-publication")
        failed_inputs = inputs.merge("GITHUB_RUN_ID" => "456", "ARTIFACT_DIR" => failed_build)
        run_helper(helper, failed_inputs, "build")
        output = run_helper(helper, failed_inputs.merge("AWS_FAIL" => stage), "publish", success: false)
        raise "provider diagnostics leaked" if output.include?("fixture-sensitive-signature")
        failed_key = File.join(env.fetch("AWS_STORE"), "runner-binaries/#{target}/456/1/#{name}.json")
        raise "failed publication advertised readiness" if File.exist?(failed_key)
        FileUtils.rm_rf(failed_build)
      end

      mutations = {
        "repository" => "other/repository", "sha" => "b" * 40, "run" => "456", "attempt" => "2",
        "target" => target.start_with?("aarch64") ? "x86_64-unknown-linux-musl" : "aarch64-unknown-linux-musl",
        "test" => name == "guest_rpc" ? "host_cpu_fairness" : "guest_rpc",
        "profile" => name == "guest_rpc" ? "release" : "ci", "sha256" => "0" * 64, "version" => 2,
        "sizeBytes" => 0
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
    upload = producer.fetch("steps").find { |step| step["run"] == "bash .github/scripts/runner-native-test-artifact.sh publish" }
    download = consumer.fetch("steps").find { |step| step["run"] == "bash .github/scripts/runner-native-test-artifact.sh download" }
    raise "missing R2 transport" unless upload && download
    raise "R2 failures must fail jobs" if upload["continue-on-error"] || download["continue-on-error"]
    raise "consumer must retain producer attempt" unless consumer.dig("env", "PRODUCER_ATTEMPT") == "${{ needs.#{prefix}-build.outputs.producer-attempt }}"
    [producer, consumer].each do |job|
      raise "credentials must stay step-scoped" if job.fetch("env").key?("AWS_SECRET_ACCESS_KEY")
    end
  end
end
puts "runner-native-test-artifact-test: ok"
RUBY
