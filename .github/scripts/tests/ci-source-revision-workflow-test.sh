#!/usr/bin/env bash
set -euo pipefail

RUBYOPT="${RUBYOPT:-} -r$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/workflow-test-owners.rb"
export RUBYOPT

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

ruby -ryaml -ropen3 -rtmpdir -rfileutils - "$repo_root" <<'RUBY'
repo_root = ARGV.fetch(0)
turbo = load_workflow_test_owners(File.join(repo_root, ".github/workflows/turbo.yml"))
jobs = turbo.fetch("jobs")
event_source = "${{ github.sha }}"

e2e_jobs = jobs.keys.select { |name| name.start_with?("cli-e2e-") }
raise "missing CLI E2E source consumers" if e2e_jobs.empty?
(%w[lint-eslint deploy-api deploy-cli deploy-app] + e2e_jobs).each do |name|
  checkouts = jobs.fetch(name).fetch("steps").select do |step|
    step.fetch("uses", "").start_with?("actions/checkout@")
  end
  unless checkouts.length == 1 && checkouts.first.dig("with", "ref") == event_source
    raise "#{name} must build/test the captured event source, not the PR head or a mutable ref"
  end
end

cli = jobs.fetch("deploy-cli")
unless cli.dig("concurrency", "group") == "deploy-cli-#{event_source}"
  raise "CLI publication concurrency must match the captured artifact source"
end
api_urls = jobs.fetch("deploy-api").fetch("steps").filter_map do |step|
  next unless step["uses"] == "./.github/actions/web-api-env"
  step.fetch("with").fetch("cli-pkg-url")
end
unless api_urls.length == 2 && api_urls.all? { |url| url == "https://static.okou.io/okou-cli/#{event_source}/package.tgz" }
  raise "API seed and deploy must consume the captured source's CLI archive"
end
artifact_step = cli.fetch("steps").find { |step| step["id"] == "artifact" }
raise "missing CLI artifact source output" unless artifact_step

def run!(command, directory, environment = {})
  stdout, stderr, status = Open3.capture3(environment, *command, chdir: directory)
  raise "#{command.first} failed: #{stderr}" unless status.success?
  stdout.strip
end

def action_outputs(script, directory, environment, output_path)
  File.write(output_path, "")
  run!(["bash", "-euo", "pipefail", "-c", script], directory, environment.merge("GITHUB_OUTPUT" => output_path))
  File.readlines(output_path, chomp: true).to_h { |line| line.split("=", 2) }
end

Dir.mktmpdir("ci-source-revision-") do |fixture|
  checkout = File.join(fixture, "checkout")
  FileUtils.mkdir_p(File.join(checkout, ".github/scripts"))
  FileUtils.cp(File.join(repo_root, ".github/scripts/resolve-build-commit-sha.sh"), File.join(checkout, ".github/scripts"))
  environment = {
    "GIT_DIR" => nil, "GIT_WORK_TREE" => nil, "GIT_INDEX_FILE" => nil, "GIT_COMMON_DIR" => nil,
    "GIT_CONFIG_GLOBAL" => "/dev/null", "GIT_CONFIG_NOSYSTEM" => "1",
    "GIT_CEILING_DIRECTORIES" => fixture, "GITHUB_WORKSPACE" => checkout
  }
  git = lambda do |*args|
    run!(["git", "-c", "user.name=CI fixture", "-c", "user.email=ci-fixture@example.invalid",
      "-c", "core.hooksPath=/dev/null", *args], checkout, environment)
  end
  git.call("init", "--quiet", "--initial-branch=main")
  git.call("add", ".")
  git.call("commit", "--quiet", "-m", "base")
  git.call("checkout", "--quiet", "-b", "fixture-pr")
  File.write(File.join(checkout, "pr.txt"), "PR source\n")
  git.call("add", ".")
  git.call("commit", "--quiet", "-m", "PR head")
  pr_head = git.call("rev-parse", "HEAD")
  git.call("checkout", "--quiet", "main")
  File.write(File.join(checkout, "main.txt"), "main integration\n")
  git.call("add", ".")
  git.call("commit", "--quiet", "-m", "main before capture")
  git.call("merge", "--quiet", "--no-ff", "fixture-pr", "-m", "captured PR merge")
  merge_sha = git.call("rev-parse", "HEAD")
  git.call("commit", "--quiet", "--allow-empty", "-m", "main advances after capture")
  later_main = git.call("rev-parse", "HEAD")
  git.call("checkout", "--quiet", "-b", "fixture-merge-group", merge_sha)
  git.call("commit", "--quiet", "--allow-empty", "-m", "captured merge group")
  queue_sha = git.call("rev-parse", "HEAD")
  unless [pr_head, merge_sha, later_main, queue_sha].uniq.length == 4
    raise "fixture must distinguish PR head, captured merge, advancing main, and merge group"
  end

  {"pull_request" => merge_sha, "merge_group" => queue_sha, "push" => later_main}.each do |event, sha|
    git.call("checkout", "--quiet", "--detach", sha)
    action_env = environment.merge("GITHUB_EVENT_NAME" => event, "GITHUB_SHA" => sha)
    artifact = action_outputs(artifact_step.fetch("run"), checkout, action_env, File.join(fixture, "artifact outputs"))
    unless artifact.fetch("sha") == sha && artifact.fetch("prefix") == "okou-cli/#{sha}"
      raise "#{event} artifact outputs must identify the actual captured checkout"
    end
    unless api_urls.all? { |url| url.sub(event_source, sha) == "https://static.okou.io/#{artifact.fetch('prefix')}/package.tgz" } &&
        cli.fetch("concurrency").fetch("group").sub(event_source, sha) == "deploy-cli-#{artifact.fetch('sha')}"
      raise "#{event} API URLs and publication concurrency must address the produced artifact"
    end
  end

  # Artifact identity follows the checkout, not an unrelated driver revision.
  git.call("checkout", "--quiet", "--detach", merge_sha)
  artifact = action_outputs(artifact_step.fetch("run"), checkout, environment.merge("GITHUB_SHA" => later_main),
    File.join(fixture, "different driver outputs"))
  unless artifact.fetch("sha") == merge_sha && artifact.fetch("prefix") == "okou-cli/#{merge_sha}"
    raise "artifact source must not be replaced with the driver SHA"
  end

  # Valid driver identity is not a fallback for a missing Git checkout.
  missing_checkout = File.join(fixture, "missing-checkout")
  FileUtils.mkdir_p(File.join(missing_checkout, ".github/scripts"))
  FileUtils.cp(File.join(repo_root, ".github/scripts/resolve-build-commit-sha.sh"), File.join(missing_checkout, ".github/scripts"))
  output_path = File.join(fixture, "invalid outputs")
  File.write(output_path, "")
  _, _, status = Open3.capture3(environment.merge("GITHUB_SHA" => later_main, "GITHUB_OUTPUT" => output_path),
    "bash", "-euo", "pipefail", "-c", artifact_step.fetch("run"), chdir: missing_checkout)
  unless !status.success? && File.read(output_path).empty?
    raise "missing checkout must fail before exposing an artifact source; no driver/branch fallback"
  end
end
puts "ci-source-revision-workflow-test: ok"
RUBY
