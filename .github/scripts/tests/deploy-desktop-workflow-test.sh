#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
# Check the artifact trust boundary and release order after the native migration.
ruby - "$repo_root" <<'RUBY'
require "yaml"
require "tmpdir"
require "open3"
require "json"
require "fileutils"
root = ARGV[0]
desktop = YAML.safe_load(File.read("#{root}/.github/workflows/desktop.yml"), aliases: true).fetch("jobs")
release = YAML.safe_load(File.read("#{root}/.github/workflows/release-please.yml"), aliases: true).fetch("jobs")
deploy = desktop.fetch("deploy-desktop")
# Evaluate the actual job conditions across event contexts, including release PRs.
evaluate = lambda do |condition, event_name, head_ref, changed, detection_result, cancelled|
  expression = condition.strip.delete_prefix('${{').delete_suffix('}}')
    .gsub("startsWith(github.head_ref, 'release-please--branches--')", "head_ref.start_with?('release-please--branches--')")
    .gsub("github.event_name", "event_name")
    .gsub("needs.detect-desktop-version.outputs.changed", "changed")
    .gsub("needs.detect-desktop-version.result", "detection_result")
    .gsub("cancelled()", "cancelled")
  # Actions adds success() unless the condition explicitly handles job status.
  default_success = condition.match?(/\b(?:always|cancelled|success|failure)\(/) || (!cancelled && detection_result == "success")
  default_success && eval(expression, binding)
end
detect_condition = desktop.fetch("detect-desktop-version").fetch("if")
{"pull_request" => false, "push" => false, "workflow_dispatch" => false, "merge_group" => true}.each do |event_name, expected|
  raise "unexpected Desktop version detection for #{event_name}" unless evaluate.call(detect_condition, event_name, "", "", "success", false) == expected
end
[
  ["pull_request", "release-please--branches--main", "", "skipped", false, false, false, false],
  ["pull_request", "fix/desktop", "", "skipped", false, true, true, false],
  ["pull_request", "release-please-imitation", "", "skipped", false, true, true, false],
  ["merge_group", "", "true", "success", false, false, false, true],
  ["merge_group", "", "false", "success", false, true, true, false],
  ["merge_group", "release-please--branches--main", "true", "success", false, false, false, true],
  ["push", "", "", "skipped", false, true, true, false],
  ["workflow_dispatch", "", "", "skipped", false, true, true, false],
  ["merge_group", "", "", "failure", false, false, true, false],
  ["merge_group", "", "false", "failure", false, false, true, false],
  ["merge_group", "", "true", "failure", false, false, true, false],
  ["merge_group", "", "false", "cancelled", false, false, true, false],
  ["merge_group", "", "false", "skipped", false, false, true, false],
  ["pull_request", "fix/desktop", "", "skipped", true, false, false, false],
  ["push", "", "", "skipped", true, false, false, false],
  ["workflow_dispatch", "", "", "skipped", true, false, false, false],
  ["merge_group", "", "true", "success", true, false, false, false]
].each do |event_name, head_ref, changed, detection_result, cancelled, native_expected, publication_expected, deploy_expected|
  {
    "test-native" => native_expected,
    "package-macos" => native_expected,
    "build-macos" => publication_expected,
    "deploy-desktop" => deploy_expected
  }.each do |job, expected|
    condition = desktop.fetch(job).fetch("if")
    raise "unexpected Desktop #{job} selection for #{event_name}/#{head_ref}/#{detection_result}/#{cancelled}" unless evaluate.call(condition, event_name, head_ref, changed, detection_result, cancelled) == expected
  end
end
gate_steps = desktop.fetch("build-macos").fetch("steps")
validation = gate_steps.find { |step| step["name"] == "Verify parallel native checks" }
download = gate_steps.find { |step| step.fetch("uses", "").start_with?("actions/download-artifact@") }
raise "native packages must follow passing native checks" unless gate_steps.index(validation) < gate_steps.index(download)
[
  ["success", "success", true],
  ["failure", "success", false],
  ["success", "failure", false],
  ["cancelled", "success", false],
  ["success", "cancelled", false],
  ["skipped", "success", false],
  ["success", "skipped", false]
].each do |native_result, package_result, expected|
  output, status = Open3.capture2e(
    {"NATIVE_TEST_RESULT" => native_result, "PACKAGE_RESULT" => package_result},
    "bash", "-c", validation.fetch("run"), chdir: root)
  raise "unexpected native publication for #{native_result}/#{package_result}: #{output}" unless status.success? == expected
end
detect = desktop.fetch("detect-desktop-version")
detect_run = detect.fetch("steps").find { |step| step["id"] == "version" }.fetch("run")
sparse_paths = detect.fetch("steps").find { |step| step.fetch("uses", "").start_with?("actions/checkout@") }
  .fetch("with").fetch("sparse-checkout").lines.map(&:strip).reject(&:empty?)
Dir.mktmpdir("desktop-version-inputs") do |dir|
  origin = "#{dir}/origin"
  Dir.mkdir(origin)
  git = lambda do |*args|
    output, status = Open3.capture2e("git", *args, chdir: origin)
    raise "fixture Git command failed: #{args}: #{output}" unless status.success?
    output.strip
  end
  git.call("init", "--quiet")
  git.call("config", "maintenance.auto", "false")
  git.call("config", "uploadpack.allowFilter", "true")
  git.call("config", "user.email", "test@example.com")
  git.call("config", "user.name", "Test")
  FileUtils.mkdir_p("#{origin}/.github/scripts/release")
  FileUtils.cp("#{root}/.github/scripts/release/resolve-desktop-version-change.sh",
    "#{origin}/.github/scripts/release/resolve-desktop-version-change.sh")
  git.call("add", ".")
  git.call("commit", "--quiet", "-m", "before version file")
  missing_version = git.call("rev-parse", "HEAD")
  Dir.mkdir("#{origin}/desktop")
  version_file = "#{origin}/desktop/version.txt"
  File.write(version_file, "1.2.3\n")
  git.call("add", ".")
  git.call("commit", "--quiet", "-m", "base version")
  base = git.call("rev-parse", "HEAD")
  File.write(version_file, "1.3.0\n")
  git.call("commit", "--quiet", "-am", "intermediate version change")
  File.write("#{origin}/README.md", "unrelated head change\n")
  git.call("add", ".")
  git.call("commit", "--quiet", "-m", "changed head")
  git.call("branch", "changed")
  File.write(version_file, "1.2.3\n")
  git.call("commit", "--quiet", "-am", "restore base version")
  git.call("branch", "unchanged")

  [
    ["changed", base, "true", "1.3.0", false],
    ["unchanged", base, "false", "1.2.3", true],
    ["changed", "0" * 40, nil, nil, false],
    ["changed", missing_version, nil, nil, false],
    ["changed", "invalid", nil, nil, false]
  ].each_with_index do |(branch, supplied_base, changed, version, already_fetched), index|
    checkout = "#{dir}/checkout-#{index}"
    git.call("clone", "--quiet", "--no-checkout", "--depth=1", "--filter=blob:none",
      "--branch", branch, "file://#{origin}", checkout)
    git.call("-C", checkout, "config", "maintenance.auto", "false")
    git.call("-C", checkout, "sparse-checkout", "set", "--no-cone", *sparse_paths)
    git.call("-C", checkout, "checkout", "--quiet", branch)
    head = git.call("-C", checkout, "rev-parse", "HEAD")
    raise "fixture must begin with only the shallow head" unless git.call("-C", checkout, "rev-list", "--count", "HEAD") == "1"
    if already_fetched
      git.call("-C", checkout, "fetch", "--no-tags", "--depth=1", "--filter=blob:none", "origin", base)
    end
    output_file = "#{dir}/output-#{index}"
    File.write(output_file, "")
    output, status = Open3.capture2e(
      {"MERGE_GROUP_BASE_SHA" => supplied_base, "GITHUB_SHA" => head, "GITHUB_OUTPUT" => output_file},
      "bash", "-c", detect_run, chdir: checkout)
    if changed
      raise "shallow version detection failed: #{output}" unless status.success?
      raise "wrong version outputs: #{File.read(output_file)}" unless File.read(output_file) == "changed=#{changed}\nversion=#{version}\n"
      raise "version detection fetched intervening history" unless git.call("-C", checkout, "rev-list", "--count", base, head) == "2"
    else
      raise "invalid version input succeeded: #{supplied_base}" if status.success?
      raise "failed version detection published outputs" unless File.read(output_file).empty?
    end
  end
end
raise "canonical artifacts must remain merge-group only" unless deploy.fetch("if").include?("github.event_name == 'merge_group'")
raise "canonical artifacts must follow version detection" unless deploy.fetch("needs") == "detect-desktop-version"
raise "artifact construction must not require production approval" if deploy.key?("environment")
steps = deploy.fetch("steps")
resolve = steps.find { |step| step["id"] == "artifact" }.fetch("run")
raise "artifact must use checked-out SHA" unless resolve.include?("resolve-build-commit-sha.sh") && resolve.include?("okou-desktop/$sha")
upload = steps.find { |step| step["name"] == "Upload canonical Desktop artifact" }.fetch("run")
raise "ready must be published after archive" unless upload.index("ready.json") > upload.index("okou-app.tar.gz")
raise "ready must include the matching symbols" unless upload.index("ready.json") > upload.index("okou-dsyms.tar.gz")
raise "ready publication must be immutable" unless upload.include?('--if-none-match "*"')
promote = release.fetch("promote-desktop-release")
raise "signing requires production approval" unless promote.fetch("environment") == "production"
raise "signer must preserve Developer ID" unless promote.fetch("env").fetch("OKOU_DESKTOP_SIGNING_IDENTITY") == "Developer ID Application: Max & Zoe, Inc. (C5UWSXYB67)"
steps = promote.fetch("steps")
fetch = steps.find { |step| step["id"] == "desktop-app" }
raise "promotion must address exact release SHA" unless fetch.fetch("env").fetch("ARTIFACT_SHA") == '${{ needs.release-please.outputs.release_target }}'
raise "promotion must verify artifact" unless fetch.fetch("run").include?("verify-okou-desktop-artifact.sh")
raise "promotion must fetch and verify canonical symbols" unless fetch.fetch("run").include?("okou-dsyms.tar.gz") && fetch.fetch("run").include?("debug_symbols.py")
sign = steps.find { |step| step["id"] == "desktop-artifacts" }
raise "promotion must sign the downloaded app without rebuild" unless sign.fetch("run").include?("--app") && sign.fetch("run").include?("--package --notarize")
raise "notary credentials must be provided together" unless sign.fetch("env").keys.sort == %w[OKOU_DESKTOP_NOTARIZE_API_ISSUER OKOU_DESKTOP_NOTARIZE_API_KEY_ID OKOU_DESKTOP_NOTARIZE_API_KEY_PATH]
verify = steps.find { |step| step["name"] == "Verify signed and notarized macOS artifacts" }.fetch("run")
raise "installation must test mounted app" unless verify.include?('"$mount/Okou.app" --verify-only')
symbols = steps.find { |step| step["name"] == "Verify published Desktop UUIDs and upload dSYMs to Sentry" }
raise "symbol upload must use actual published ZIP and DMG" unless symbols.fetch("run").include?("gh release download") && symbols.fetch("run").include?("--zip") && symbols.fetch("run").include?("--dmg") && symbols.fetch("run").include?("--upload")
raise "symbol upload must follow asset publication" unless steps.index(symbols) > steps.index(steps.find { |step| step["name"] == "Upload Desktop artifacts to GitHub Releases" })
raise "native symbols must target Desktop" unless promote.fetch("env").fetch("SENTRY_PROJECT") == "desktop"
# Existing readiness must never convert missing symbols into a rebuild of a
# published SHA. Execute the real reuse step and artifact reader against R2.
existing = deploy.fetch("steps").find { |step| step["id"] == "existing" }.fetch("run")
Dir.mktmpdir("desktop-artifact-reuse") do |dir|
  bin = "#{dir}/bin"
  Dir.mkdir(bin)
  File.write("#{bin}/aws", <<~'SH')
    #!/usr/bin/env bash
    set -euo pipefail
    if [[ "$1 $2" == "s3api head-object" ]]; then
      if [[ "$MOCK_READY" == "false" ]]; then
        echo '404 Not Found' >&2
        exit 255
      fi
    elif [[ "$1 $2" == "s3 cp" ]]; then
      cp "$MOCK_ARTIFACT/${3##*/}" "$4"
    else
      echo 'Unexpected R2 mutation' >&2
      exit 99
    fi
  SH
  File.chmod(0755, "#{bin}/aws")
  app = "#{dir}/package/Okou.app"
  FileUtils.mkdir_p(app)
  %w[Okou.app.dSYM computer-use-helper.dSYM].each { |bundle| FileUtils.mkdir_p("#{dir}/package/dSYMs/#{bundle}") }
  artifact = "#{dir}/artifact"
  target = "a" * 40
  output, status = Open3.capture2e("bash", "#{root}/.github/scripts/artifacts/build-okou-desktop-artifact.sh", target, "1.2.3", app, artifact)
  raise "fixture artifact failed: #{output}" unless status.success?
  [["false", true, "exists=false\n"], ["true", true, "exists=true\n"], ["true", false, ""]].each do |ready, complete, expected|
    FileUtils.rm_f("#{artifact}/okou-dsyms.tar.gz") unless complete
    output_file = "#{dir}/output"
    File.write(output_file, "")
    env = {"PATH" => "#{bin}:#{ENV.fetch('PATH')}", "ARTIFACT_PREFIX" => "okou-desktop/#{target}",
      "ARTIFACT_SHA" => target, "DESKTOP_VERSION" => "1.2.3", "AWS_ACCESS_KEY_ID" => "test",
      "AWS_SECRET_ACCESS_KEY" => "test", "R2_ACCOUNT_ID" => "test", "R2_BUCKET_NAME" => "test",
      "GITHUB_OUTPUT" => output_file, "MOCK_ARTIFACT" => artifact, "MOCK_READY" => ready,
      "OKOU_DESKTOP_ARTIFACT_FETCH_RETRY_DELAY_SECONDS" => "0"}
    output, status = Open3.capture2e(env, "bash", "-c", existing, chdir: root)
    raise "unexpected artifact reuse result: #{output}" unless status.success? == complete
    raise "invalid artifact was selected for rebuild/reuse" unless File.read(output_file) == expected
  end
end
# Run the actual promotion step against the external GitHub CLI boundary.
# A retry preserves signed assets already published and fills partial uploads.
publish_artifacts = steps.find { |step| step["name"] == "Upload Desktop artifacts to GitHub Releases" }.fetch("run")
Dir.mktmpdir("desktop-publish-contract") do |dir|
  bin = "#{dir}/bin"
  Dir.mkdir(bin)
  File.write("#{bin}/gh", <<~'SH')
    #!/usr/bin/env bash
    set -euo pipefail
    case "$1 $2" in
      "release view")
        if [[ "$*" == *"--json targetCommitish"* ]]; then
          printf '%s\n' "$MOCK_RELEASE_TARGET"
        elif [[ "$*" == *"--json assets"* ]]; then
          printf '%s\n' "$MOCK_RELEASE_ASSETS"
        else
          [ "$MOCK_RELEASE_EXISTS" = 1 ]
        fi
        ;;
      "release create") printf 'create\n' >> "$MOCK_PUBLISH_LOG" ;;
      "release upload")
        [[ "$*" != *"--clobber"* ]] || exit 99
        printf 'upload %s\n' "$(basename "$4")" >> "$MOCK_PUBLISH_LOG"
        ;;
      *) exit 98 ;;
    esac
  SH
  File.chmod(0755, "#{bin}/gh")
  target = "a" * 40
  zip = "Okou-darwin-arm64-0.53.0.zip"
  dmg = "Okou-darwin-arm64-0.53.0.dmg"
  script = publish_artifacts
    .gsub('${{ github.repository }}', 'okou-ai/okou')
    .gsub('${{ steps.desktop-artifacts.outputs.okou_zip_path }}', "#{dir}/#{zip}")
    .gsub('${{ steps.desktop-artifacts.outputs.okou_dmg_path }}', "#{dir}/#{dmg}")
  [["0", "", ["create", "upload #{zip}", "upload #{dmg}"]],
   ["1", "#{zip}\n#{dmg}", []],
   ["1", zip, ["upload #{dmg}"]]].each do |exists, assets, expected|
    log = "#{dir}/calls"
    File.write(log, "")
    env = {"PATH" => "#{bin}:#{ENV.fetch('PATH')}", "RELEASE_TARGET" => target,
      "OKOU_RELEASE_TAG" => "okou-desktop-v0.53.0", "DESKTOP_VERSION" => "0.53.0",
      "MOCK_RELEASE_TARGET" => target, "MOCK_RELEASE_EXISTS" => exists,
      "MOCK_RELEASE_ASSETS" => assets, "MOCK_PUBLISH_LOG" => log}
    output, status = Open3.capture2e(env, "bash", "-c", script)
    raise "Desktop publication failed: #{output}" unless status.success?
    raise "Desktop rerun replaced a published asset" unless File.readlines(log, chomp: true) == expected
  end
  log = "#{dir}/calls"
  File.write(log, "")
  output, status = Open3.capture2e({"PATH" => "#{bin}:#{ENV.fetch('PATH')}",
    "RELEASE_TARGET" => target, "OKOU_RELEASE_TAG" => "okou-desktop-v0.53.0",
    "MOCK_RELEASE_TARGET" => "b" * 40, "MOCK_RELEASE_EXISTS" => "1",
    "MOCK_RELEASE_ASSETS" => "", "MOCK_PUBLISH_LOG" => log}, "bash", "-c", script)
  raise "Mismatched Desktop target must stop before upload" if status.success? || !File.read(log).empty?
end
publish = release.fetch("publish-desktop-update-manifest")
raise "feed must wait for notarized release assets" unless publish.fetch("needs").include?("promote-desktop-release") && publish.fetch("if").include?("needs.promote-desktop-release.result == 'success'")
raise "feed must wait for the API appcast deployment" unless publish.fetch("needs").include?("promote-api-production") && publish.fetch("if").include?("needs.promote-api-production.result == 'success'")
condition = publish.fetch("if")
evaluate_publication = lambda do |created, desktop_result, api_result, ancestors, cancelled|
  expression = condition.strip.delete_prefix('${{').delete_suffix('}}')
    .gsub("needs.release-please.outputs.desktop_release_created", created.inspect)
    .gsub("needs.promote-desktop-release.result", desktop_result.inspect)
    .gsub("needs.promote-api-production.result", api_result.inspect)
    .gsub("always()", "true").gsub("cancelled()", cancelled.inspect)
  # Actions injects success() when no status function overrides it, including
  # skipped transitive Runner dependencies in an API + Desktop release.
  default_success = condition.match?(/\b(?:always|cancelled|success|failure)\(/) || ancestors.all? { |result| result == "success" }
  default_success && eval(expression, binding)
end
[
  ["true", "success", "success", ["success"], false, true],
  ["true", "success", "success", ["success", "skipped"], false, true],
  ["true", "success", "success", ["success"], true, false],
  ["false", "success", "success", ["success"], false, false],
  ["true", "failure", "success", ["failure"], false, false],
  ["true", "success", "failure", ["failure"], false, false],
  ["true", "skipped", "success", ["skipped"], false, false],
  ["true", "success", "skipped", ["skipped"], false, false]
].each do |created, desktop_result, api_result, ancestors, cancelled, expected|
  raise "unexpected manifest publication selection" unless evaluate_publication.call(created, desktop_result, api_result, ancestors, cancelled) == expected
end
raise "normal publication must reuse the recovery workflow" unless publish.fetch("uses") == "./.github/workflows/desktop-update-manifest.yml"
raise "publication must verify the source workflow run" unless publish.fetch("with").fetch("release_run_id") == '${{ github.run_id }}'
manifest_workflow = YAML.safe_load(File.read("#{root}/.github/workflows/desktop-update-manifest.yml"), aliases: true)
publish = manifest_workflow.fetch("jobs").fetch("publish")
raise "publication requires production approval" unless publish.fetch("environment") == "production"
raise "publication must use trusted main workflow definitions" unless publish.fetch("if") == "github.ref == 'refs/heads/main'"
source = publish.fetch("steps").find { |step| step["id"] == "source" }.fetch("run")
Dir.mktmpdir("desktop-manifest-source") do |dir|
  bin = "#{dir}/bin"
  Dir.mkdir(bin)
  File.write("#{bin}/gh", <<~'SH')
    #!/usr/bin/env bash
    set -euo pipefail
    case "$*" in
      *"--json targetCommitish"*) printf '%s\n' "$MOCK_DESKTOP_TARGET" ;;
      *"--json assets"*) printf '%s\n' "$MOCK_DESKTOP_ASSETS" ;;
      *"/jobs?"*) cat "$MOCK_SOURCE_JOBS" ;;
      *"/compare/"*) printf '%s\n' "$MOCK_MERGE_BASE" ;;
      *"/contents/desktop/version.txt?"*) printf '%s\n' '0.54.6' | base64 ;;
      *"/git/ref/tags/desktop-v"*) printf '{"object":{"type":"commit","sha":"%s"}}\n' "$MOCK_COMPONENT_TARGET" ;;
      *"/actions/runs/123") cat "$MOCK_SOURCE_RUN" ;;
      *) echo 'Unexpected GitHub operation' >&2; exit 99 ;;
    esac
  SH
  File.chmod(0755, "#{bin}/gh")
  target = "a" * 40
  run = {"path" => ".github/workflows/release-please.yml", "event" => "push", "head_branch" => "main", "head_sha" => target, "conclusion" => "success"}
  jobs = %w[release-please promote-desktop-release promote-api-production].map { |name| {"name" => name, "conclusion" => "success"} }
  # A release commit can be followed by another merge in the same push. A
  # failed overall run can still have successfully promoted Desktop and API.
  cases = [[run, jobs, true], [run.merge("conclusion" => nil), jobs, true],
    [run.merge("head_sha" => "b" * 40), jobs, true],
    [run.merge("head_sha" => "b" * 40, "conclusion" => "failure"), jobs, true],
    [run.merge("path" => ".github/workflows/desktop.yml"), jobs, false],
    [run.merge("head_branch" => "feature"), jobs, false],
    [run.merge("event" => "pull_request"), jobs, false],
    [run.merge("head_sha" => "main"), jobs, false],
    [run.merge("conclusion" => "cancelled"), jobs, false],
    [run, jobs[0..1], false]]
  %w[failure cancelled skipped].each do |result|
    [1, 2].each do |index|
      cases << [run.merge("conclusion" => "failure"), jobs.each_with_index.map { |job, i| i == index ? job.merge("conclusion" => result) : job }, false]
    end
  end
  cases.each do |source_run, source_jobs, expected|
    File.write("#{dir}/run.json", JSON.generate(source_run))
    File.write("#{dir}/jobs.jsonl", source_jobs.map { |job| JSON.generate(job) }.join("\n"))
    output_file = "#{dir}/outputs"
    File.write(output_file, "")
    env = {"PATH" => "#{bin}:#{ENV.fetch('PATH')}", "GITHUB_REPOSITORY" => "okou-ai/okou", "RELEASE_RUN_ID" => "123",
      "RELEASE_TARGET" => target, "MOCK_MERGE_BASE" => target, "MOCK_COMPONENT_TARGET" => target,
      "GITHUB_OUTPUT" => output_file, "MOCK_SOURCE_RUN" => "#{dir}/run.json", "MOCK_SOURCE_JOBS" => "#{dir}/jobs.jsonl"}
    output, status = Open3.capture2e(env, "bash", "-c", source)
    raise "unexpected source release acceptance: #{output}" unless status.success? == expected
    expected_output = expected ? "sha=#{target}\nversion=0.54.6\n" : ""
    raise "unverified source SHA escaped" unless File.read(output_file) == expected_output
  end
  File.write("#{dir}/run.json", JSON.generate(run.merge("head_sha" => "b" * 40, "conclusion" => "failure")))
  File.write("#{dir}/jobs.jsonl", jobs.map { |job| JSON.generate(job) }.join("\n"))
  [{"MOCK_MERGE_BASE" => "c" * 40}, {"MOCK_COMPONENT_TARGET" => "b" * 40}].each do |mismatch|
    output_file = "#{dir}/outputs"
    File.write(output_file, "")
    env = {"PATH" => "#{bin}:#{ENV.fetch('PATH')}", "GITHUB_REPOSITORY" => "okou-ai/okou", "RELEASE_RUN_ID" => "123",
      "RELEASE_TARGET" => target, "MOCK_MERGE_BASE" => target, "MOCK_COMPONENT_TARGET" => target,
      "GITHUB_OUTPUT" => output_file, "MOCK_SOURCE_RUN" => "#{dir}/run.json", "MOCK_SOURCE_JOBS" => "#{dir}/jobs.jsonl"}.merge(mismatch)
    output, status = Open3.capture2e(env, "bash", "-c", source)
    raise "Unrelated release target must not be published: #{output}" if status.success? || !File.read(output_file).empty?
  end
  identity = publish.fetch("steps").find { |step| step["name"] == "Resolve Desktop release identity" }.fetch("run")
  Dir.mkdir("#{dir}/desktop")
  ["0.54.6", "0.54.5"].each do |version|
    File.write("#{dir}/desktop/version.txt", "#{version}\n")
    env_file = "#{dir}/env"
    File.write(env_file, "")
    output, status = Open3.capture2e({"EXPECTED_VERSION" => "0.54.6", "GITHUB_ENV" => env_file}, "bash", "-c", identity, chdir: dir)
    expected = version == "0.54.6"
    raise "unexpected checked-out release identity: #{output}" unless status.success? == expected
    expected_env = expected ? "DESKTOP_VERSION=0.54.6\nOKOU_RELEASE_TAG=okou-desktop-v0.54.6\n" : ""
    raise "wrong Desktop version escaped" unless File.read(env_file) == expected_env
  end
  assets = publish.fetch("steps").find { |step| step["name"] == "Verify Desktop release assets" }.fetch("run")
    .gsub('${{ github.repository }}', 'okou-ai/okou')
  zip = "Okou-darwin-arm64-0.54.6.zip"
  dmg = "Okou-darwin-arm64-0.54.6.dmg"
  [[target, "#{zip}\n#{dmg}", true], ["b" * 40, "#{zip}\n#{dmg}", false],
    [target, zip, false], [target, dmg, false]].each do |asset_target, names, expected|
    env = {"PATH" => "#{bin}:#{ENV.fetch('PATH')}", "GITHUB_REPOSITORY" => "okou-ai/okou",
      "RELEASE_TARGET" => target, "DESKTOP_VERSION" => "0.54.6", "OKOU_RELEASE_TAG" => "okou-desktop-v0.54.6",
      "MOCK_DESKTOP_TARGET" => asset_target, "MOCK_DESKTOP_ASSETS" => names}
    output, status = Open3.capture2e(env, "bash", "-c", assets)
    raise "unexpected Desktop asset acceptance: #{output}" unless status.success? == expected
  end
end
publication = publish.fetch("steps").find { |step| step["name"] == "Publish Desktop update manifest to R2" }
raise "R2 publication must retain the verified release identity" unless publication.fetch("env").fetch("PUBLICATION_SHA") == '${{ steps.source.outputs.sha }}'
raise "R2 publication must use the static bucket" unless publication.fetch("env").fetch("R2_BUCKET_NAME") == '${{ vars.R2_STATIC_BUCKET_NAME }}'
RUBY
node --test "$repo_root/.github/scripts/tests/desktop-release-manifest-test.mjs"
echo "native Desktop workflow tests passed"
