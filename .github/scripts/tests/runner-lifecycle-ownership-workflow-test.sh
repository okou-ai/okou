#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cleanup_workflow="${repo_root}/.github/workflows/cleanup.yml"
stale_workflow="${repo_root}/.github/workflows/cleanup-stale.yml"
turbo_workflow="${repo_root}/.github/workflows/turbo.yml"

ruby -ryaml - \
  "$cleanup_workflow" \
  "$stale_workflow" \
  "$turbo_workflow" <<'RUBY'
def named_step(job, name)
  job.fetch("steps").find { |step| step["name"] == name }
end

cleanup_workflow = YAML.load_file(ARGV.fetch(0))
workflow_triggers = cleanup_workflow["on"] || cleanup_workflow.fetch(true)
pull_request_target = workflow_triggers.fetch("pull_request_target")
unless pull_request_target.fetch("types").sort == %w[closed reopened]
  raise "cleanup must invalidate close-event runs when a pull request is reopened"
end

cleanup_workflow.fetch("jobs").each do |job_name, job|
  unless job.fetch("if", "").include?("github.event.action == 'closed'")
    raise "cleanup job #{job_name} must run only for closed pull requests"
  end
end

cleanup_concurrency = cleanup_workflow.fetch("concurrency")
unless cleanup_concurrency == {
  "group" => "cleanup-pr-${{ github.event.pull_request.number }}",
  "cancel-in-progress" => true,
}
  raise "cleanup must deduplicate in a namespace distinct from active PR CI owners"
end

cleanup = cleanup_workflow.fetch("jobs").fetch("cleanup-runner")
permissions = cleanup.fetch("permissions")
unless permissions == {
  "actions" => "write",
  "contents" => "read",
  "pull-requests" => "read",
}
  raise "cleanup runner needs cancellation and closed-PR lookup permissions"
end

checkout = cleanup.fetch("steps").find { |step| step.fetch("uses", "").start_with?("actions/checkout@") }
unless checkout&.dig("with", "ref") == "${{ github.event.repository.default_branch }}" &&
    checkout&.dig("with", "persist-credentials") == false
  raise "cleanup runner must execute the trusted default-branch ownership script"
end

cleanup_names = cleanup.fetch("steps").map { |step| step["name"] }
cleanup_runner = named_step(cleanup, "Cleanup PR runners on all metal hosts")
cleanup_runner_script = cleanup_runner.fetch("run")
cleanup_lock_index = cleanup_runner_script.index(".github/scripts/runner/with-runner-lifecycle-lock.sh")
cleanup_action_index = cleanup_runner_script.index(".github/scripts/runner/cleanup-pr-runner-namespace.sh")
unless cleanup_lock_index && cleanup_action_index && cleanup_lock_index < cleanup_action_index &&
    cleanup_runner_script.include?('JOB_REF="pr-${PR_NUMBER}"') &&
    cleanup_runner_script.include?("export JOB_REF") &&
    cleanup_runner.dig("env", "GH_TOKEN") == "${{ github.token }}" &&
    cleanup_runner.dig("env", "GITHUB_REPOSITORY") == "${{ github.repository }}" &&
    cleanup_runner.dig("env", "GITHUB_RUN_ID") == "${{ github.run_id }}"
  raise "immediate cleanup must hold the namespace lifecycle lock through deletion"
end
if cleanup_names.include?("Cleanup crates runner on all metal hosts")
  raise "runner cleanup must not split one PR namespace across unlocked lane lists"
end

stale = YAML.load_file(ARGV.fetch(1)).fetch("jobs").fetch("cleanup-metal-runners")
unless stale.fetch("permissions") == {
  "actions" => "write",
  "contents" => "read",
  "pull-requests" => "read",
}
  raise "stale runner cleanup needs cancellation and closed-PR lookup permissions"
end
stale_checkout = stale.fetch("steps").find { |step| step.fetch("uses", "").start_with?("actions/checkout@") }
unless stale_checkout&.dig("with", "ref") == "${{ github.sha }}" &&
    stale_checkout&.dig("with", "persist-credentials") == false
  raise "stale runner cleanup must execute the scheduled or manually selected workflow commit"
end

stale_names = stale.fetch("steps").map { |step| step["name"] }
ssh_index = stale_names.index("Setup SSH via Cloudflare Tunnel")
discovery_index = stale_names.index("Discover runner PR namespaces")
selection_index = stale_names.index("Select closed runner PRs")
cleanup_index = stale_names.index("Cleanup stale runners")
unless ssh_index && discovery_index && selection_index && cleanup_index &&
    ssh_index < discovery_index && discovery_index < selection_index &&
    selection_index < cleanup_index
  raise "stale cleanup must inspect hosts before selecting closed PR namespaces"
end

discovery = named_step(stale, "Discover runner PR namespaces")
unless discovery.fetch("run") == ".github/scripts/runner/discover-runner-pr-namespaces.sh" &&
    discovery.dig("env", "METAL_HOSTS") == "${{ secrets.AWS_METAL_RUNNER_HOSTS }}" &&
    discovery.dig("env", "METAL_USER") == "${{ vars.AWS_METAL_RUNNER_USER }}"
  raise "stale cleanup must derive candidates from configured metal hosts"
end

selection = named_step(stale, "Select closed runner PRs")
selection_script = selection.dig("with", "script")
unless selection.dig("env", "PR_NUMBERS") == "${{ steps.runner-prs.outputs.numbers }}" &&
    selection_script.include?("github.rest.pulls.get") &&
    selection_script.include?("pull.state === 'closed'") &&
    !selection_script.include?("github.rest.pulls.list")
  raise "stale cleanup must resolve every discovered namespace against current PR state"
end

stale_cleanup = named_step(stale, "Cleanup stale runners")
raise "missing stale runner cleanup" unless stale_cleanup
unless stale_cleanup.dig("env", "GH_TOKEN") == "${{ github.token }}" &&
    stale_cleanup.dig("env", "GITHUB_REPOSITORY") == "${{ github.repository }}" &&
    stale_cleanup.dig("env", "GITHUB_RUN_ID") == "${{ github.run_id }}"
  raise "stale runner cleanup must receive the ownership API context"
end
stale_script = stale_cleanup.fetch("run")
stale_dry_run_index = stale_script.index('if [ "$DRY_RUN" = "true" ]')
stale_lock_index = stale_script.index(".github/scripts/runner/with-runner-lifecycle-lock.sh")
stale_action_index = stale_script.index(".github/scripts/runner/cleanup-pr-runner-namespace.sh")
unless stale_dry_run_index && stale_lock_index && stale_action_index &&
    stale_dry_run_index < stale_lock_index &&
    stale_lock_index < stale_action_index &&
    stale_script.include?('JOB_REF="pr-${PR_NUMBER}"') && stale_script.include?("export JOB_REF")
  raise "stale cleanup must hold the namespace lock through cancellation and deletion"
end
unless stale_script.include?('if [ "$FAILED" -gt 0 ]') &&
    !stale_script.include?("playbooks/cleanup-crates-runner.yml")
  raise "stale runner cleanup must report failures and avoid a duplicated Crates cleanup list"
end

turbo = YAML.load_file(ARGV.fetch(2)).fetch("jobs")
prepare = turbo.fetch("deploy-runner-prepare")
start = turbo.fetch("deploy-runner-start")
unless prepare.dig("outputs", "runner-sha-map") ==
    "${{ steps.manifest.outputs.runner-sha-map }}"
  raise "runner prepare must expose producer SHA ownership by target"
end
unless start.fetch("permissions") == {"actions" => "read", "contents" => "read"}
  raise "runner recovery must have read-only workflow permissions"
end

locked_start = named_step(start, "Reconcile and start runner under lifecycle lock")
raise "missing locked runner reconciliation and start" unless locked_start
unless locked_start.dig("env", "AWS_METAL_RUNNER_HOSTS") ==
      "${{ secrets.AWS_METAL_RUNNER_HOSTS }}" &&
    locked_start.dig("env", "BIN_DIR") == "${{ needs.deploy-runner-prepare.outputs.bin-dir }}" &&
    locked_start.dig("env", "JOB_REF") == "${{ needs.prepare.outputs.runner-image-job-ref }}" &&
    locked_start.dig("env", "METAL_HOSTS") == "${{ secrets.AWS_METAL_RUNNER_HOSTS }}" &&
    locked_start.dig("env", "RUNNER_SHA_MAP") ==
      "${{ needs.deploy-runner-prepare.outputs.runner-sha-map }}" &&
    locked_start.fetch("run").include?(".github/scripts/runner/with-runner-lifecycle-lock.sh") &&
    locked_start.fetch("run").include?(".github/scripts/runner/reconcile-and-start-runner-groups.sh") &&
    !locked_start.key?("continue-on-error")
  raise "runner reconciliation and readiness must share cleanup's namespace lifecycle lock"
end
RUBY

echo "runner-lifecycle-ownership-workflow-test: ok"
