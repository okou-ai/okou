#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
# Check the artifact trust boundary and release order after the native migration.
ruby - "$repo_root" <<'RUBY'
require "yaml"
require "tmpdir"
require "open3"
require "json"
root = ARGV[0]
desktop = YAML.safe_load(File.read("#{root}/.github/workflows/desktop.yml"), aliases: true).fetch("jobs")
release = YAML.safe_load(File.read("#{root}/.github/workflows/release-please.yml"), aliases: true).fetch("jobs")
deploy = desktop.fetch("deploy-desktop")
# Evaluate the actual job conditions across event contexts, including release PRs.
build_condition = desktop.fetch("build-macos").fetch("if")
deploy_condition = deploy.fetch("if")
evaluate = lambda do |condition, event_name, head_ref, changed|
  expression = condition.strip.delete_prefix('${{').delete_suffix('}}')
    .gsub("startsWith(github.head_ref, 'release-please--branches--')", "head_ref.start_with?('release-please--branches--')")
    .gsub("github.event_name", "event_name")
    .gsub("needs.detect-desktop-version.outputs.changed", "changed")
  eval(expression, binding)
end
[
  ["pull_request", "release-please--branches--main", "false", false, false],
  ["pull_request", "fix/desktop", "false", true, false],
  ["pull_request", "release-please-imitation", "false", true, false],
  ["merge_group", "", "true", false, true],
  ["merge_group", "", "false", true, false],
  ["merge_group", "release-please--branches--main", "true", false, true],
  ["push", "", "true", true, false],
  ["workflow_dispatch", "", "false", true, false]
].each do |event_name, head_ref, changed, build_expected, deploy_expected|
  raise "unexpected Desktop build selection for #{event_name}/#{head_ref}" unless evaluate.call(build_condition, event_name, head_ref, changed) == build_expected
  raise "unexpected Desktop artifact selection for #{event_name}/#{head_ref}" unless evaluate.call(deploy_condition, event_name, head_ref, changed) == deploy_expected
end
raise "canonical artifacts must remain merge-group only" unless deploy.fetch("if").include?("github.event_name == 'merge_group'")
raise "canonical artifacts must follow version detection" unless deploy.fetch("needs") == "detect-desktop-version"
raise "artifact construction must not require production approval" if deploy.key?("environment")
steps = deploy.fetch("steps")
resolve = steps.find { |step| step["id"] == "artifact" }.fetch("run")
raise "artifact must use checked-out SHA" unless resolve.include?("resolve-build-commit-sha.sh") && resolve.include?("okou-desktop/$sha")
upload = steps.find { |step| step["name"] == "Upload canonical Desktop artifact" }.fetch("run")
raise "ready must be published after archive" unless upload.index("ready.json") > upload.index("okou-app.tar.gz")
raise "ready publication must be immutable" unless upload.include?('--if-none-match "*"')
promote = release.fetch("promote-desktop-release")
raise "signing requires production approval" unless promote.fetch("environment") == "production"
raise "signer must preserve Developer ID" unless promote.fetch("env").fetch("OKOU_DESKTOP_SIGNING_IDENTITY") == "Developer ID Application: Max & Zoe, Inc. (C5UWSXYB67)"
steps = promote.fetch("steps")
fetch = steps.find { |step| step["id"] == "desktop-app" }
raise "promotion must address exact release SHA" unless fetch.fetch("env").fetch("ARTIFACT_SHA") == '${{ needs.release-please.outputs.release_target }}'
raise "promotion must verify artifact" unless fetch.fetch("run").include?("verify-okou-desktop-artifact.sh")
sign = steps.find { |step| step["id"] == "desktop-artifacts" }
raise "promotion must sign the downloaded app without rebuild" unless sign.fetch("run").include?("--app") && sign.fetch("run").include?("--package --notarize")
raise "notary credentials must be provided together" unless sign.fetch("env").keys.sort == %w[OKOU_DESKTOP_NOTARIZE_API_ISSUER OKOU_DESKTOP_NOTARIZE_API_KEY_ID OKOU_DESKTOP_NOTARIZE_API_KEY_PATH]
verify = steps.find { |step| step["name"] == "Verify signed and notarized macOS artifacts" }.fetch("run")
raise "installation must test mounted app" unless verify.include?('"$mount/Okou.app" --verify-only')
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
      *) cat "$MOCK_SOURCE_RUN" ;;
    esac
  SH
  File.chmod(0755, "#{bin}/gh")
  target = "a" * 40
  run = {"path" => ".github/workflows/release-please.yml", "event" => "push", "head_branch" => "main", "head_sha" => target, "conclusion" => "success"}
  jobs = %w[release-please promote-desktop-release promote-api-production].map { |name| {"name" => name, "conclusion" => "success"} }
  cases = [[run, jobs, true], [run.merge("conclusion" => nil), jobs, true],
    [run.merge("path" => ".github/workflows/desktop.yml"), jobs, false],
    [run.merge("head_branch" => "feature"), jobs, false],
    [run.merge("event" => "pull_request"), jobs, false],
    [run.merge("head_sha" => "main"), jobs, false],
    [run.merge("conclusion" => "cancelled"), jobs, false],
    [run, jobs[0..1], false]]
  %w[failure cancelled skipped].each do |result|
    [1, 2].each do |index|
      cases << [run, jobs.each_with_index.map { |job, i| i == index ? job.merge("conclusion" => result) : job }, false]
    end
  end
  cases.each do |source_run, source_jobs, expected|
    File.write("#{dir}/run.json", JSON.generate(source_run))
    File.write("#{dir}/jobs.jsonl", source_jobs.map { |job| JSON.generate(job) }.join("\n"))
    output_file = "#{dir}/outputs"
    File.write(output_file, "")
    env = {"PATH" => "#{bin}:#{ENV.fetch('PATH')}", "GITHUB_REPOSITORY" => "okou-ai/okou", "RELEASE_RUN_ID" => "123",
      "GITHUB_OUTPUT" => output_file, "MOCK_SOURCE_RUN" => "#{dir}/run.json", "MOCK_SOURCE_JOBS" => "#{dir}/jobs.jsonl"}
    output, status = Open3.capture2e(env, "bash", "-c", source)
    raise "unexpected source release acceptance: #{output}" unless status.success? == expected
    expected_output = expected ? "sha=#{target}\n" : ""
    raise "unverified source SHA escaped" unless File.read(output_file) == expected_output
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
