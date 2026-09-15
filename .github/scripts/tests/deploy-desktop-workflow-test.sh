#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
desktop_workflow="${repo_root}/.github/workflows/desktop.yml"
release_workflow="${repo_root}/.github/workflows/release-please.yml"
turbo_workflow="${repo_root}/.github/workflows/turbo.yml"

if grep -q '^  deploy-desktop:' "$turbo_workflow"; then
  echo "deploy-desktop must remain outside turbo.yml" >&2
  exit 1
fi

# The Ruby program is intentionally a literal single-quoted shell argument.
# shellcheck disable=SC2016
ruby -e '
  require "yaml"

  desktop = YAML.safe_load(File.read(ARGV[0]), aliases: true).fetch("jobs")
  release = YAML.safe_load(File.read(ARGV[1]), aliases: true).fetch("jobs")
  desktop_text = File.read(ARGV[0])
  release_text = File.read(ARGV[1])

  canonical_signing_identity = "OKOU_DESKTOP_SIGNING_IDENTITY"
  canonical_writer_counts = {
    "OKOU_DESKTOP_PRODUCT" => [6, 2],
    "OKOU_DESKTOP_PLATFORM_URL" => [9, 2],
    canonical_signing_identity => [0, 5],
  }
  canonical_writer_counts.each do |name, expected_counts|
    actual_counts = [desktop_text.scan(name).length, release_text.scan(name).length]
    raise "Desktop workflows must use the complete canonical environment writer surface" unless actual_counts == expected_counts
  end

  detector = desktop.fetch("detect-desktop-version")
  build = desktop.fetch("build-macos")
  {"default-configuration" => "default", "Okou production" => "production", "PR preview" => "preview"}.each do |variant, lane|
    smoke = build.fetch("steps").find { |step| step["name"] == "Smoke test #{variant} artifact launch" }
    evidence_key = "OKOU_DESKTOP_SMOKE_EVIDENCE_PATH"
    evidence_root = "${{ runner.temp }}/desktop-smoke-evidence/#{lane}"
    raise "Smoke evidence must stay outside the packaged app" unless smoke.fetch("env").fetch(evidence_key) == "#{evidence_root}/startup.json"
    raise "Each packaged variant must verify its signature before launch" unless smoke.fetch("run").include?("--signed")
  end
  deploy = desktop.fetch("deploy-desktop")
  raise "deploy-desktop must depend on version detection" unless deploy.fetch("needs") == "detect-desktop-version"
  raise "deploy-desktop must not use a GitHub environment" if deploy.key?("environment")
  raise "deploy-desktop must use the version detector output" unless deploy.fetch("if").include?(ARGV[2])
  raise "deploy-desktop must only publish merge-group commits" unless deploy.fetch("if").include?(ARGV[3])

  detector_run = detector.fetch("steps").find { |step| step["id"] == "version" }.fetch("run")
  raise "version detector must compare Desktop package versions" unless detector_run.include?("resolve-desktop-version-change.sh")

  default_build = build.fetch("steps").find { |step| step["id"] == "build-prod" }
  raise "Desktop CI must build the default configuration" unless default_build
  raise "Default CI build must not select a product" if default_build.fetch("env").key?("OKOU_DESKTOP_PRODUCT")
  raise "Default CI build must not select a platform URL" if default_build.fetch("env").key?("OKOU_DESKTOP_PLATFORM_URL")

  default_verify = build.fetch("steps").find { |step| step["name"] == "Verify default-configuration artifact" }.fetch("run")
  raise "Default CI build must package the Okou identity" unless default_verify.include?("ai.okou.desktop")
  raise "Default CI build must stay free of a baked-in runtime config" unless default_verify.include?("should not contain desktop runtime config")

  okou_build = build.fetch("steps").find { |step| step["id"] == "build-okou-prod" }
  raise "Desktop CI must build the Okou product" unless okou_build
  raise "Okou CI build must select the Okou product" unless okou_build.fetch("env").fetch("OKOU_DESKTOP_PRODUCT") == "okou"
  raise "Okou CI build must use app.okou.ai" unless okou_build.fetch("env").fetch("OKOU_DESKTOP_PLATFORM_URL") == "https://app.okou.ai"
  raise "Okou CI build must package runtime product identity" unless okou_build.fetch("run").include?("product: process.env.OKOU_DESKTOP_PRODUCT")

  okou_verify = build.fetch("steps").find { |step| step["name"] == "Verify Okou production artifact" }.fetch("run")
  raise "Okou artifact must verify its bundle ID" unless okou_verify.include?("ai.okou.desktop")
  raise "Okou artifact must verify its packaged runtime config" unless okou_verify.include?("desktop-runtime-config.json")

  preview = build.fetch("steps").find { |step| step["id"] == "preview" }
  preview_env = preview.fetch("env")
  raise "Desktop preview must use the Workers subdomain" unless preview_env.fetch("CF_WORKERS_SUBDOMAIN") == "${{ vars.CF_WORKERS_SUBDOMAIN }}"
  raise "Desktop preview URL must pass the Workers subdomain" unless preview.fetch("run").include?("$CF_WORKERS_SUBDOMAIN")

  artifact_step = deploy.fetch("steps").find { |step| step["id"] == "artifact" }
  raise "deploy-desktop must resolve the checked-out commit" unless artifact_step.fetch("run").include?("resolve-build-commit-sha.sh")
  raise "deploy-desktop must use a SHA-addressed R2 prefix" unless artifact_step.fetch("run").include?(ARGV[6])

  build_step = deploy.fetch("steps").find { |step| step["name"] == "Build canonical unsigned Desktop app" }
  raise "canonical Desktop build must skip signing" unless build_step.fetch("env").fetch("OKOU_DESKTOP_SKIP_SIGNING") == "true"
  raise "canonical Desktop build must package Okou" unless build_step.fetch("run").include?("Okou.app")
  raise "canonical Okou build must select the Okou product" unless build_step.fetch("env").fetch("OKOU_DESKTOP_PRODUCT") == "okou"
  raise "canonical Okou build must target app.okou.ai" unless build_step.fetch("env").fetch("OKOU_DESKTOP_PLATFORM_URL") == "https://app.okou.ai"
  raise "canonical Desktop build must package exactly one runtime config" unless build_step.fetch("run").include?("must contain exactly one Desktop runtime config")
  raise "canonical Desktop build must verify the packaged runtime config contents" unless build_step.fetch("run").include?("Unexpected canonical Desktop runtime config")
  raise "canonical Desktop build must package the app once" unless build_step.fetch("run").scan("electron-forge package").length == 1

  artifact_build = deploy.fetch("steps").find { |step| step["name"] == "Create canonical Desktop artifact" }.fetch("run")
  raise "canonical artifact must contain the Okou app" unless artifact_build.include?("Okou-darwin-arm64/Okou.app")

  artifact_upload = deploy.fetch("steps").find { |step| step["name"] == "Upload canonical Desktop artifact" }.fetch("run")
  raise "canonical artifact must upload the Okou archive" unless artifact_upload.include?("okou-app.tar.gz")

  promote = release.fetch("promote-desktop-release")
  expected_signing_identity = "Developer ID Application: Max & Zoe, Inc. (C5UWSXYB67)"
  raise "Desktop promotion must define the canonical signing identity" unless promote.fetch("env").fetch(canonical_signing_identity) == expected_signing_identity
  raise "Desktop promotion must use production environment" unless promote.fetch("environment") == "production"
  checkout = promote.fetch("steps").find { |step| step["uses"].to_s.start_with?("actions/checkout@") }
  raise "Desktop promotion must check out release_target" unless checkout.fetch("with").fetch("ref") == ARGV[4]

  download = promote.fetch("steps").find { |step| step["id"] == "desktop-app" }.fetch("run")
  raise "Desktop promotion must fetch the canonical R2 artifact" unless download.include?("fetch-okou-desktop-artifact.sh")
  raise "Desktop promotion must verify the canonical R2 artifact" unless download.include?("verify-okou-desktop-artifact.sh")
  raise "Desktop promotion must address artifacts by release_target" unless download.include?(ARGV[5])
  raise "Desktop promotion must extract the Okou app archive" unless download.include?("okou-app.tar.gz")

  promote_text = release_text.split("  promote-desktop-release:\n", 2).fetch(1).split(/\n  [a-zA-Z0-9_-]+:\n/, 2).first
  dollar = 36.chr
  canonical_credentials = {
    "OKOU_DESKTOP_NOTARIZE_API_KEY_PATH" => dollar + "{{ steps.notary-key.outputs.path }}",
    "OKOU_DESKTOP_NOTARIZE_API_KEY_ID" => dollar + "{{ secrets.APP_STORE_CONNECT_API_KEY_ID }}",
    "OKOU_DESKTOP_NOTARIZE_API_ISSUER" => dollar + "{{ secrets.APP_STORE_CONNECT_API_ISSUER_ID }}",
  }
  credential_steps = promote.fetch("steps").select do |step|
    environment = step.fetch("env", {})
    canonical_credentials.keys.any? { |name| environment.key?(name) }
  end
  raise "Desktop promotion must define one atomic API credential source" unless credential_steps.length == 1
  notarize_step = credential_steps.fetch(0)
  raise "Desktop promotion must bind the canonical API credential triple together" unless notarize_step.fetch("env") == canonical_credentials

  canonical_occurrences_are_exact = canonical_credentials.keys.all? do |name|
    release_text.scan(name).length == 2
  end
  raise "Desktop release workflow must use each canonical API credential alias exactly twice" unless canonical_occurrences_are_exact

  notarize_run = notarize_step.fetch("run")
  raise "Desktop app signing must consume the atomic API credential source" unless notarize_run.include?("sign-and-notarize-packaged-app.mjs")
  canonical_notarytool_arguments = [
    "--key \"#{dollar}OKOU_DESKTOP_NOTARIZE_API_KEY_PATH\"",
    "--key-id \"#{dollar}OKOU_DESKTOP_NOTARIZE_API_KEY_ID\"",
    "--issuer \"#{dollar}OKOU_DESKTOP_NOTARIZE_API_ISSUER\"",
  ]
  raise "Desktop DMG notarization must consume the canonical API credential triple" unless canonical_notarytool_arguments.all? { |argument| notarize_run.include?(argument) }
  raise "Desktop DMG notarization must submit through a single canonical invocation" unless notarize_run.scan("xcrun notarytool submit").length == 1
  raise "Desktop DMG notarization must survive a transient notary poll failure" unless notarize_run.include?("for attempt in 1 2 3")
  raise "Desktop DMG notarization must bound notary retries" unless notarize_run.include?("Notarization did not complete after 3 attempts")
  raise "Desktop DMG notarization must not retry a terminal Apple verdict" unless notarize_run.include?("status: (Invalid|Rejected)")
  raise "Desktop DMG notarization must not let tee mask a notarytool failure" unless notarize_run.include?("set -o pipefail")
  raise "Desktop DMG stapling must follow a successful notarization" unless notarize_run.index("stapler staple") > notarize_run.index("notarize_status")
  raise "Desktop promotion must not rebuild the app" if promote_text.include?("pnpm -F @okouai/desktop build")
  raise "Desktop promotion must sign the downloaded app" unless promote_text.include?("sign-and-notarize-packaged-app.mjs")
  raise "Desktop promotion must publish an independent Okou release" unless promote_text.include?("OKOU_RELEASE_TAG: okou-desktop-v")
  raise "Desktop promotion must publish Okou artifacts" unless promote_text.include?("Okou-darwin-arm64-")
  raise "Desktop promotion must smoke-test Okou installation" unless promote_text.include?("okou-install-smoke")
  raise "Desktop promotion must smoke-test Okou updates" unless promote_text.include?("okou-update-smoke")

  publish = release.fetch("publish-desktop-update-manifest")
  raise "Desktop manifest must wait for promotion" unless Array(publish.fetch("needs")).include?("promote-desktop-release")
  publish_text = publish.fetch("steps").find { |step| step["name"] == "Publish Desktop update manifest" }.fetch("run")
  raise "Desktop manifests must publish the Okou feed" unless publish_text.include?("ai-okou-desktop-update-manifest.json")
  raise "Desktop manifests must publish under the Okou mutable tag" unless publish_text.include?("ai-okou-desktop-updates")
' \
  "$desktop_workflow" \
  "$release_workflow" \
  "needs.detect-desktop-version.outputs.changed == 'true'" \
  "github.event_name == 'merge_group'" \
  "\${{ needs.release-please.outputs.release_target }}" \
  "okou-desktop/\${ARTIFACT_SHA}" \
  "okou-desktop/\$sha"

grep -q '^  merge_group:' "$desktop_workflow"

echo "deploy-desktop workflow tests passed"
