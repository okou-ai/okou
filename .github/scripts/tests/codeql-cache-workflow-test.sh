#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "${script_dir}/../.." && pwd)"
workflow="${repo_root}/.github/workflows/security.yml"

ruby -ryaml - "$workflow" <<'RUBY'
workflow = YAML.load_file(ARGV.fetch(0), aliases: true)
jobs = workflow.fetch("jobs")
codeql = jobs.fetch("codeql")
condition = codeql.fetch("if")

unless condition.include?("github.event_name != 'merge_group'") &&
    condition.include?("needs.detect-native-only.outputs.ios-only == 'false'")
  raise "CodeQL event boundaries changed"
end

init = codeql.fetch("steps").find do |step|
  step["name"] == "Initialize CodeQL"
end
raise "CodeQL init step is missing" unless init
raise "CodeQL init action changed" unless init.fetch("uses") ==
  "github/codeql-action/init@b96794f015dfd88f77b49b1c93e0fa7110f94c63"
raise "CodeQL language changed" unless init.fetch("with").fetch("languages") ==
  "javascript-typescript"
raise "CodeQL must use action-managed TRAP caching" if
  init.fetch("with").key?("trap-caching")
raise "CodeQL must use action-managed overlay caching" if
  init.fetch("env", {}).key?("CODEQL_ACTION_OVERLAY_DATABASE_CACHE")

analyze = codeql.fetch("steps").find do |step|
  step["name"] == "Perform CodeQL Analysis"
end
raise "CodeQL analyze step is missing" unless analyze
raise "CodeQL analyze action changed" unless analyze.fetch("uses") ==
  "github/codeql-action/analyze@b96794f015dfd88f77b49b1c93e0fa7110f94c63"
raise "CodeQL SARIF category changed" unless analyze.fetch("with").fetch("category") ==
  "codeql"
raise "Security gate no longer requires CodeQL" unless
  jobs.fetch("ci-gate-security").fetch("needs").include?("codeql")
RUBY

echo "codeql-cache-workflow-test: ok"
