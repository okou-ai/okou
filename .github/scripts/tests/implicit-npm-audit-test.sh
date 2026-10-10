#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

ruby -ryaml - "$repo_root" <<'RUBY'
repo_root = ARGV.fetch(0)

def load_yaml(path)
  YAML.load_file(path, aliases: true)
end

def audit_setting(*environments)
  environments.reverse_each do |environment|
    next unless environment.is_a?(Hash)

    key = environment.keys.find do |candidate|
      candidate.to_s.downcase == "npm_config_audit"
    end
    return environment.fetch(key).to_s if key
  end
  nil
end

def command_lines(script, command)
  script.lines.filter do |line|
    stripped = line.strip
    next false if stripped.empty? || stripped.start_with?("#")

    stripped.match?(
      /(?:\A|&&\s*|\|\|\s*|;\s*)(?:RUN\s+)?#{command}/,
    )
  end
end

def implicit_npm_install?(script)
  install = /(?:npm_config_audit=false\s+)?npm\s+(?:ci|install|i)\b/
  command_lines(script, install).any? do |line|
    !line.match?(/(?:\A|\s)(?:-g|--global)(?:\s|\z)/) &&
      !line.include?("--no-audit") &&
      !line.include?("npm_config_audit=false")
  end
end

violations = []
explicit_audit_paths = []
expected_audit_path = ".github/workflows/security.yml"

workflow_paths = Dir[File.join(repo_root, ".github/workflows/*.{yml,yaml}")]
workflow_paths.each do |path|
  document = load_yaml(path)
  workflow_environment = document.fetch("env", {})
  relative_path = path.delete_prefix("#{repo_root}/")

  # An event wrapper has no worker environment, and its env would not propagate
  # through workflow_call. Every execution owner is checked in this same scan.
  execution_owner = document.fetch("jobs", {}).values.any? { |job| job.key?("steps") }
  if execution_owner && audit_setting(workflow_environment) != "false"
    violations << "#{relative_path} must set top-level npm_config_audit=false"
  end

  document.fetch("jobs", {}).each do |job_name, job|
    next unless job.is_a?(Hash)

    job_environment = job.fetch("env", {})
    job.fetch("steps", []).each_with_index do |step, index|
      next unless step.is_a?(Hash)

      effective_audit = audit_setting(
        workflow_environment,
        job_environment,
        step.fetch("env", {}),
      )
      location = "#{path.delete_prefix("#{repo_root}/")}:#{job_name}:step-#{index + 1}"

      if step.fetch("uses", "").start_with?("pnpm/action-setup@") &&
          effective_audit != "false"
        violations << "#{location} runs pnpm/action-setup without npm_config_audit=false"
      end

      run = step.fetch("run", "")
      if implicit_npm_install?(run) && effective_audit != "false"
        violations << "#{location} runs an implicit npm audit"
      end
      unless command_lines(run, /(?:npm|pnpm)\s+audit\b/).empty?
        explicit_audit_paths << path.delete_prefix("#{repo_root}/")
      end
    end
  end
end

action_paths = Dir[File.join(repo_root, ".github/actions/**/action.{yml,yaml}")]
action_paths.each do |path|
  document = load_yaml(path)
  document.dig("runs", "steps")&.each_with_index do |step, index|
    next unless step.is_a?(Hash)

    location = "#{path.delete_prefix("#{repo_root}/")}:step-#{index + 1}"
    effective_audit = audit_setting(step.fetch("env", {}))
    run = step.fetch("run", "")

    if step.fetch("uses", "").start_with?("pnpm/action-setup@") &&
        effective_audit != "false"
      violations << "#{location} runs pnpm/action-setup without npm_config_audit=false"
    end
    if implicit_npm_install?(run) && effective_audit != "false"
      violations << "#{location} runs an implicit npm audit"
    end
    unless command_lines(run, /(?:npm|pnpm)\s+audit\b/).empty?
      explicit_audit_paths << path.delete_prefix("#{repo_root}/")
    end
  end
end

script_globs = [
  ".github/scripts/**/*.sh",
  ".devcontainer/**/*.sh",
  "scripts/**/*.sh",
  "crates/**/scripts/**/*.sh",
  "e2e/**/*.sh",
  "e2e/**/*.bash",
  "e2e/**/*.bats",
  "docker/**/Dockerfile*",
]
script_paths = script_globs.flat_map do |glob|
  Dir[File.join(repo_root, glob)]
end.uniq.reject do |path|
  path.end_with?("/.github/scripts/tests/implicit-npm-audit-test.sh") ||
    path.include?("/e2e/test/libs/")
end

script_paths.each do |path|
  content = File.read(path)
  relative_path = path.delete_prefix("#{repo_root}/")

  if implicit_npm_install?(content) &&
      !content.match?(/^\s*export\s+npm_config_audit=false\b/)
    violations << "#{relative_path} runs an implicit npm audit"
  end
  unless command_lines(content, /(?:npm|pnpm)\s+audit\b/).empty?
    explicit_audit_paths << relative_path
  end
end

unless explicit_audit_paths.uniq == [expected_audit_path]
  violations << "explicit dependency audit must remain owned only by #{expected_audit_path}"
end

unless violations.empty?
  warn violations.join("\n")
  exit 1
end
RUBY

test_script='npx --yes --package=https://example.invalid/package.tgz okou --help'
expected_prompt=$'@shell@\nexport npm_config_audit=false\nnpx --yes --package=https://example.invalid/package.tgz okou --help\n@end-shell@'
actual_prompt=$(bash -c '
source "$1"
runner_e2e_shell_prompt "$2"
' _ "$repo_root/e2e/helpers/runner-api.bash" "$test_script")

if [[ "$actual_prompt" != "$expected_prompt" ]]; then
  echo "runner E2E shell prompts must disable npm audit before caller code" >&2
  exit 1
fi
