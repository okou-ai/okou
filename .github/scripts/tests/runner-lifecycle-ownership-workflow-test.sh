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
  "actions" => "read",
  "contents" => "read",
  "pull-requests" => "read",
}
  raise "cleanup runner must have only the permissions needed for ownership handoff"
end

checkout = cleanup.fetch("steps").find { |step| step.fetch("uses", "").start_with?("actions/checkout@") }
unless checkout&.dig("with", "ref") == "${{ github.event.repository.default_branch }}" &&
    checkout&.dig("with", "persist-credentials") == false
  raise "cleanup runner must execute the trusted default-branch ownership script"
end

# Both triggers use the same command and credential boundary. Behavioral
# ownership/reopen/lock checks live in cleanup-metal-test.py.
stale = YAML.load_file(ARGV.fetch(1)).fetch("jobs").fetch("cleanup-metal-runners")
stale_checkout = stale.fetch("steps").find { |step| step.fetch("uses", "").start_with?("actions/checkout@") }
raise "stale cleanup must use its captured source revision" unless
  stale_checkout&.dig("with", "ref") == "${{ github.sha }}" &&
  stale_checkout&.dig("with", "persist-credentials") == false

[cleanup, stale].each do |job|
  step = job.fetch("steps").find { |candidate| candidate.fetch("run", "").include?("cleanup-metal-runners.py") }
  unless step && step.dig("env", "GH_TOKEN") == "${{ github.token }}" &&
    step.dig("env", "GITHUB_REPOSITORY") == "${{ github.repository }}" &&
    step.dig("env", "GITHUB_RUN_ID") == "${{ github.run_id }}" &&
    step.dig("env", "METAL_HOSTS") == "${{ secrets.AWS_METAL_RUNNER_HOSTS }}" &&
    !step.key?("continue-on-error") && job.fetch("permissions") == permissions
    raise "cleanup must preserve shared authority, inventory and failure propagation"
  end
end
raise "scheduled sweeps must serialize without cancelling cleanup" unless
  stale.fetch("concurrency").fetch("cancel-in-progress") == false

turbo = YAML.load_file(ARGV.fetch(2)).fetch("jobs")
stripe = turbo.fetch("deploy-stripe-listener").fetch("steps").find { |step| step.fetch("run", "").include?("start-stripe-listener.sh") }
raise "Stripe replacement must share the cleanup namespace lock" unless
  stripe && stripe.fetch("run").include?("with-runner-lifecycle-lock.sh") && !stripe.key?("continue-on-error")

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
