#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
# Check the artifact trust boundary and release order after the native migration.
ruby - "$repo_root" <<'RUBY'
require "yaml"
require "tmpdir"
require "open3"
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
raise "legacy updater manifest must stay on same line" unless publish.fetch("steps").any? { |step| step.fetch("run", "").include?("ai-okou-desktop-update-manifest.json") }
RUBY
echo "native Desktop workflow tests passed"
