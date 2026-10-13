#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

ruby -ryaml - "$repo_root/.github/workflows/turbo.yml" <<'RUBY'
jobs = YAML.load_file(ARGV.fetch(0)).fetch("jobs")
api_needs = Array(jobs.fetch("deploy-api").fetch("needs"))
raise "deploy-api must depend on prepare" unless api_needs.include?("prepare")
raise "deploy-api must not wait for CLI publication" if api_needs.include?("deploy-cli")

cli = jobs.fetch("deploy-cli")
raise "CLI verification failures must block deployment" if cli["continue-on-error"]
steps = cli.fetch("steps")
verification = steps.select do |step|
  step.fetch("run", "").include?("verify-okou-cli-artifact.sh")
end
cdn = verification.find do |step|
  step.fetch("run").include?("download-okou-cli-cdn-file.sh")
end
local = verification.find do |step|
  !step.fetch("run").include?("download-okou-cli-cdn-file.sh")
end
raise "CLI deployment must verify both local and CDN artifacts" unless local && cdn
[local, cdn].each do |step|
  unless step.fetch("run").include?("smoke-okou-cli-artifact.sh") &&
      step.dig("env", "ARTIFACT_SHA") == "${{ steps.artifact.outputs.sha }}" &&
      !step["continue-on-error"]
    raise "each artifact boundary must verify the captured source and run a blocking smoke check"
  end
end
unless cdn.dig("env", "ARTIFACT_PREFIX") == "${{ steps.artifact.outputs.prefix }}"
  raise "CDN verification must download the captured artifact"
end
RUBY

echo "deploy-cli-workflow tests passed"
