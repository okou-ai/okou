#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
# Check the artifact trust boundary and release order after the native migration.
ruby - "$repo_root" <<'RUBY'
require "yaml"
root = ARGV[0]
desktop = YAML.safe_load(File.read("#{root}/.github/workflows/desktop.yml"), aliases: true).fetch("jobs")
release = YAML.safe_load(File.read("#{root}/.github/workflows/release-please.yml"), aliases: true).fetch("jobs")
deploy = desktop.fetch("deploy-desktop")
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
publish = release.fetch("publish-desktop-update-manifest")
raise "feed must wait for notarized release assets" unless publish.fetch("needs").include?("promote-desktop-release") && publish.fetch("if").include?("needs.promote-desktop-release.result == 'success'")
raise "legacy updater manifest must stay on same line" unless publish.fetch("steps").any? { |step| step.fetch("run", "").include?("ai-okou-desktop-update-manifest.json") }
RUBY
echo "native Desktop workflow tests passed"
