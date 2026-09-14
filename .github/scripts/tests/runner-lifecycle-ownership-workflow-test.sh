#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cleanup_workflow="${repo_root}/.github/workflows/cleanup.yml"
stale_workflow="${repo_root}/.github/workflows/cleanup-stale.yml"
turbo_workflow="${repo_root}/.github/workflows/turbo.yml"
namespace_cleanup="${repo_root}/.github/scripts/cleanup-pr-runner-namespace.sh"
namespace_discovery="${repo_root}/.github/scripts/discover-runner-pr-namespaces.sh"
runner_cleanup_playbook="${repo_root}/ansible/playbooks/cleanup-pr-runner.yml"

ruby -ryaml - \
  "$cleanup_workflow" \
  "$stale_workflow" \
  "$turbo_workflow" \
  "$namespace_cleanup" \
  "$namespace_discovery" \
  "$runner_cleanup_playbook" <<'RUBY'
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
  "actions" => "read",
  "contents" => "read",
  "pull-requests" => "read",
}
  raise "cleanup runner must have only the permissions needed for ownership handoff"
end

checkout = cleanup.fetch("steps").find { |step| step["uses"] == "actions/checkout@v7.0.1" }
unless checkout&.dig("with", "ref") == "${{ github.event.repository.default_branch }}" &&
    checkout&.dig("with", "persist-credentials") == false
  raise "cleanup runner must execute the trusted default-branch ownership script"
end

handoff = named_step(cleanup, "Wait for active CI owners before runner cleanup")
raise "missing closed-PR ownership handoff" unless handoff
unless handoff.fetch("if").include?("steps.check.outputs.should-cleanup") &&
    handoff.dig("env", "GH_TOKEN") == "${{ github.token }}" &&
    handoff.dig("env", "GITHUB_REPOSITORY") == "${{ github.repository }}" &&
    handoff.dig("env", "GITHUB_RUN_ID") == "${{ github.run_id }}" &&
    handoff.dig("env", "PR_NUMBER") == "${{ github.event.pull_request.number }}" &&
    handoff.dig("env", "RUNNER_OWNER_SCOPE") == "closed-pr-cleanup" &&
    handoff.fetch("run") == ".github/scripts/cancel-superseded-merge-group-runs.sh" &&
    !handoff.key?("continue-on-error")
  raise "closed-PR ownership handoff must fail closed"
end

cleanup_names = cleanup.fetch("steps").map { |step| step["name"] }
unless cleanup_names.index("Wait for active CI owners before runner cleanup") <
    cleanup_names.index("Cleanup PR runners on all metal hosts")
  raise "ownership handoff must complete before shared runner resources are deleted"
end
cleanup_runner = named_step(cleanup, "Cleanup PR runners on all metal hosts")
cleanup_runner_script = cleanup_runner.fetch("run")
cleanup_lock_index = cleanup_runner_script.index(".github/scripts/with-runner-lifecycle-lock.sh")
cleanup_action_index = cleanup_runner_script.index(".github/scripts/cleanup-pr-runner-namespace.sh")
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
  "actions" => "read",
  "contents" => "read",
  "pull-requests" => "read",
}
  raise "stale runner cleanup must use the same ownership permissions"
end
stale_checkout = stale.fetch("steps").find { |step| step["uses"] == "actions/checkout@v7.0.1" }
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
unless discovery.fetch("run") == ".github/scripts/discover-runner-pr-namespaces.sh" &&
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
stale_handoff_index = stale_script.index("RUNNER_OWNER_SCOPE=closed-pr-cleanup")
stale_lock_index = stale_script.index(".github/scripts/with-runner-lifecycle-lock.sh")
stale_action_index = stale_script.index(".github/scripts/cleanup-pr-runner-namespace.sh")
unless stale_dry_run_index && stale_handoff_index && stale_lock_index && stale_action_index &&
    stale_dry_run_index < stale_handoff_index && stale_handoff_index < stale_lock_index &&
    stale_lock_index < stale_action_index &&
    stale_script.include?('JOB_REF="pr-${PR_NUMBER}"') && stale_script.include?("export JOB_REF")
  raise "stale cleanup must await discovered owners and hold the namespace lock through deletion"
end
unless stale_script.include?('if [ "$FAILED" -gt 0 ]') &&
    !stale_script.include?("playbooks/cleanup-crates-runner.yml")
  raise "stale runner cleanup must report failures and avoid a duplicated Crates cleanup list"
end

namespace_cleanup = File.read(ARGV.fetch(3))
state_index = namespace_cleanup.index("pr_state=")
closed_index = namespace_cleanup.index('if [ "$pr_state" != "closed" ]')
locked_probe_index = namespace_cleanup.index("RUNNER_OWNER_ASSERT_IDLE=true")
barrier_index = namespace_cleanup.index("cancel-superseded-merge-group-runs.sh")
delete_index = namespace_cleanup.index("playbooks/cleanup-pr-runner.yml")
unless state_index && closed_index && locked_probe_index && barrier_index && delete_index &&
    locked_probe_index < barrier_index && barrier_index < state_index &&
    state_index < closed_index && closed_index < delete_index &&
    namespace_cleanup.include?("RUNNER_OWNER_SCOPE=closed-pr-cleanup")
  raise "locked cleanup must recheck PR state and stabilized ownership before deletion"
end

namespace_discovery = File.read(ARGV.fetch(4))
unless namespace_discovery.include?("systemctl list-units") &&
    namespace_discovery.include?("systemctl list-unit-files") &&
    namespace_discovery.include?("/var/lib/vm0-runner/bin") &&
    namespace_discovery.include?("/var/lib/vm0-runner/runners") &&
    namespace_discovery.include?("/var/lib/vm0-runner/groups") &&
    namespace_discovery.include?('(^|-)pr-([1-9][0-9]*)(-|$)')
  raise "runner namespace discovery must cover services and delimited PR directories"
end

runner_cleanup_playbook = File.read(ARGV.fetch(5))
unless runner_cleanup_playbook.include?("job_ref is match('^pr-[1-9][0-9]*$')") &&
    runner_cleanup_playbook.include?("'vm0-runner-{{ job_ref }}-*'") &&
    runner_cleanup_playbook.include?('/^vm0-runner-{{ job_ref }}-[a-z0-9][a-z0-9.-]*\\.service$/') &&
    runner_cleanup_playbook.include?('- "{{ job_ref }}-*"') &&
    runner_cleanup_playbook.include?('- "*-{{ job_ref }}-*"') &&
    !runner_cleanup_playbook.include?("process-containment")
  raise "runner cleanup must select one strict PR namespace without per-lane duplication"
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
    locked_start.fetch("run").include?(".github/scripts/with-runner-lifecycle-lock.sh") &&
    locked_start.fetch("run").include?(".github/scripts/reconcile-and-start-runner-groups.sh") &&
    !locked_start.key?("continue-on-error")
  raise "runner reconciliation and readiness must share cleanup's namespace lifecycle lock"
end
RUBY

echo "runner-lifecycle-ownership-workflow-test: ok"
