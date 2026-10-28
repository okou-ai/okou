#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
WORKFLOW="${REPO_ROOT}/.github/workflows/turbo.yml"
RUNNER_TESTS="${REPO_ROOT}/e2e/tests/03-runner"
RUNNER_HELPERS=(
  "${REPO_ROOT}/e2e/helpers/runner-api.bash"
  "${REPO_ROOT}/e2e/helpers/runner-chat.bash"
)
RUNNER_TOKEN="${REPO_ROOT}/e2e/playwright/runner-token.ts"
RUNNER_MOCK_CLAUDE_BOOTSTRAP="${REPO_ROOT}/e2e/playwright/runner-mock-claude-bootstrap.bash"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

grep -Fq "RUNNER_SERVICE_REF: \${{ needs.prepare.outputs.job-ref }}" "$WORKFLOW" ||
  fail "runner service identity must follow the deployed API job ref"
grep -Fq "RUNNER_GROUP: \${{ format('vm0/development-{0}', needs.prepare.outputs.job-ref) }}" "$WORKFLOW" ||
  fail "runner group must match the deployed API default group"
if grep -Fq 'playwright-staging' "$WORKFLOW"; then
  fail "main Playwright runs must not use a group outside the staging API default"
fi
if grep -R -Fq '/api/test/' "$RUNNER_TESTS" "${RUNNER_HELPERS[@]}"; then
  fail "runner E2E coverage must use supported public APIs"
fi
# Keep paid prerequisites for every retained runtime/billing isolation group.
if [[ "$(grep -Fc 'upgradeToPro: true' "$RUNNER_TOKEN")" -ne 3 ||
  "$(grep -Fc 'fileName: "' "$RUNNER_TOKEN")" -ne 3 ]]; then
  fail "all three runner isolation groups must upgrade to Pro"
fi

ruby -ryaml -ropen3 -rtempfile - "$WORKFLOW" "$RUNNER_MOCK_CLAUDE_BOOTSTRAP" <<'RUBY'
workflow = YAML.load_file(ARGV.fetch(0))
jobs = workflow.fetch("jobs")
prepare = jobs.fetch("prepare")
stripe_listener = jobs.fetch("deploy-stripe-listener")
browser = jobs.fetch("cli-e2e-02-browser")
playwright = jobs.fetch("cli-e2e-02-playwright")
playwright_finalizer = jobs.fetch("cli-e2e-02-playwright-finalize")
account_prepare = jobs.fetch("cli-e2e-03-runner-prepare")
account_prepare_steps = account_prepare.fetch("steps")
model_selection_index = account_prepare_steps.index do |step|
  step.fetch("run", "").include?("scripts/runner-model-selection.test.ts")
end
prepare_accounts_index = account_prepare_steps.index do |step|
  step["id"] == "account"
end
unless model_selection_index && prepare_accounts_index &&
    model_selection_index < prepare_accounts_index
  raise "runner E2E must check model selection before preparing real accounts"
end
bootstrap = jobs.fetch("cli-e2e-03-runner-bootstrap")
runner = jobs.fetch("cli-e2e-03-runner")
account_cleanup = jobs.fetch("cli-e2e-03-runner-cleanup")
unless playwright_finalizer["continue-on-error"] == true
  raise "Playwright finalization must not fail the workflow"
end
unless account_cleanup["continue-on-error"] == true
  raise "runner E2E cleanup must not fail the workflow"
end
if playwright.key?("continue-on-error") || runner.key?("continue-on-error")
  raise "actual Playwright and runner E2E jobs must remain blocking"
end
expected_api_backend_url = "${{ needs.deploy-api.outputs.preview-url }}"
assert_canonical_api_backend_url = lambda do |step, name|
  environment = step.fetch("env")
  unless environment["OKOU_API_BACKEND_URL"] == expected_api_backend_url
    raise "#{name} must receive the canonical API preview URL"
  end
end
browser_run = browser.fetch("steps").find do |step|
  step.fetch("run", "").include?("./e2e/tests/02-browser/")
end
raise "missing browser E2E execution" unless browser_run
if browser_run["continue-on-error"] || browser["continue-on-error"]
  raise "browser E2E failures must remain blocking"
end
assert_canonical_api_backend_url.call(browser_run, "browser E2E")
expected_playwright_group =
  "cli-e2e-02-playwright-${{ needs.prepare.outputs.job-ref }}"
unless playwright.dig("concurrency", "group") == expected_playwright_group
  raise "the Playwright smoke must use its job-ref concurrency group"
end
unless playwright.dig("concurrency", "cancel-in-progress") == true
  raise "superseding runs must cancel the matching Playwright smoke"
end
playwright_run = playwright.fetch("steps").find do |step|
  step["id"] == "playwright-tests"
end
unless playwright_run&.fetch("shell") == "bash" &&
    !playwright_run["continue-on-error"] && !playwright["continue-on-error"] &&
    playwright_run.fetch("run").include?("--project=chat-smoke")
  raise "the Playwright job must run its blocking chat smoke project"
end
assert_canonical_api_backend_url.call(playwright_run, "Playwright E2E")
unless Array(playwright_finalizer["needs"]).include?("cli-e2e-02-playwright")
  raise "Playwright report finalizer must wait for the smoke job"
end
unless prepare.dig("outputs", "turbo-runner-consumer-needed") ==
    "${{ steps.runner-e2e.outputs.turbo-runner-consumer-needed }}"
  raise "Turbo must expose the historical runner E2E consumer decision"
end
consumer_step = prepare.fetch("steps").find do |step|
  step["id"] == "runner-e2e"
end
unless consumer_step&.fetch("run", "")&.end_with?("runner-image-context.sh turbo-consumer")
  raise "Turbo must restore the historical runner E2E consumer detector"
end

stripe_listener_condition = stripe_listener.fetch("if")
stripe_listener_lines = stripe_listener_condition.lines.map(&:strip)
expected_stripe_listener_consumers = [
  "needs.prepare.outputs.turbo-runner-consumer-needed == 'true' ||",
  "needs.prepare.outputs.playwright-runner-consumer-needed == 'true'",
]
unless stripe_listener_lines.each_cons(2).include?(expected_stripe_listener_consumers)
  raise "Stripe forwarding must run for every deployed E2E consumer"
end

unless runner.dig("strategy", "fail-fast") == false
  raise "runner E2E shards must not fail fast"
end
expected_matrix = "${{ fromJSON(needs.cli-e2e-03-runner-prepare.outputs.runner-shard-matrix) }}"
unless runner.dig("strategy", "matrix") == expected_matrix
  raise "runner E2E must use the generated non-empty shard matrix"
end

expected_group = "cli-e2e-03-runner-${{ matrix.index }}-${{ needs.prepare.outputs.job-ref }}"
unless runner.dig("concurrency", "group") == expected_group
  raise "each runner E2E shard must keep its independent concurrency group"
end

required_needs = %w[
  prepare
  deploy-api
  deploy-runner-prepare
  deploy-runner-start
  cli-e2e-03-runner-prepare
  cli-e2e-03-runner-bootstrap
]
unless required_needs.all? { |job_name| Array(runner["needs"]).include?(job_name) }
  raise "runner E2E shards must wait for accounts, API, and runner deployment"
end

unless account_prepare.fetch("if").include?("turbo-runner-consumer-needed == 'true'")
  raise "runner E2E account preparation must use the runner E2E consumer"
end
unless runner.fetch("if").include?("turbo-runner-consumer-needed == 'true'")
  raise "runner E2E shards must use the runner E2E consumer"
end

%w[deploy-runner-prepare deploy-runner-start].each do |job_name|
  condition = jobs.fetch(job_name).fetch("if")
  unless condition.include?("turbo-runner-consumer-needed == 'true'") &&
      condition.include?("playwright-runner-consumer-needed == 'true'")
    raise "#{job_name} must serve both runner E2E and Playwright consumers"
  end
end

prepare_step = account_prepare.fetch("steps").find do |step|
  step["id"] == "account"
end
raise "missing runner E2E account preparation" unless prepare_step
unless prepare_step.fetch("run").end_with?("runner-account.ts prepare")
  raise "runner E2E account preparation must use the shared lifecycle entry point"
end

unless %w[prepare deploy-api deploy-app deploy-stripe-listener].all? do |job_name|
    Array(account_prepare["needs"]).include?(job_name)
  end
  raise "runner E2E account preparation must wait for previews and Stripe forwarding"
end
unless account_prepare.fetch("if").include?(
    "github.event_name == 'push' || needs.deploy-stripe-listener.result == 'success'"
  )
  raise "runner E2E account preparation must use staging or preview Stripe forwarding"
end

expected_organization_outputs = {
  "codex-organization-id" => "codex-organization-id",
  "mock-claude-organization-id" => "mock-claude-organization-id",
  "codex-built-in-organization-id" => "codex-built-in-organization-id",
}
expected_organization_outputs.each do |job_output, step_output|
  expected = "${{ steps.account.outputs.#{step_output} }}"
  unless account_prepare.dig("outputs", job_output) == expected
    raise "runner E2E account preparation must expose #{job_output}"
  end
end
unless account_prepare.dig("outputs", "runner-shard-matrix") ==
    "${{ steps.shards.outputs.matrix }}"
  raise "runner E2E preparation must expose the generated shard matrix"
end

shard_generation_step = account_prepare.fetch("steps").find do |step|
  step["id"] == "shards"
end
raise "missing runner E2E shard generation" unless shard_generation_step
shard_generation_script = shard_generation_step.fetch("run")
unless shard_generation_step["id"] == "shards" &&
    shard_generation_script.include?("playwright/runner-shards.ts tests/03-runner") &&
    shard_generation_script.include?('length > 0 and length <= 12') &&
    shard_generation_script.include?('echo "matrix=$matrix" >> "$GITHUB_OUTPUT"')
  raise "runner E2E shard generation must use the tested executable and reject empty matrices"
end

token_step = account_prepare.fetch("steps").find do |step|
  step.fetch("run", "").include?("playwright/runner-token.ts")
end
raise "missing runner E2E token generation" unless token_step
assert_canonical_api_backend_url.call(token_step, "runner token generation")
unless token_step.fetch("run").end_with?("runner-token.ts /tmp")
  raise "runner E2E tokens must use the public device-flow entry point"
end
unless token_step.dig("env", "OKOU_APP_URL") == "${{ needs.deploy-app.outputs.preview-url }}"
  raise "runner E2E token generation must emit the app preview URL"
end
unless token_step.dig("env", "E2E_RUNNER_MOCK_CLAUDE_ORGANIZATION_ID") ==
    "${{ steps.account.outputs.mock-claude-organization-id }}"
  raise "runner E2E token generation must receive the mock Claude organization"
end
unless token_step.dig("env", "E2E_RUNNER_CODEX_BUILT_IN_ORGANIZATION_ID") ==
    "${{ steps.account.outputs.codex-built-in-organization-id }}"
  raise "runner E2E token generation must receive the built-in Codex organization"
end

sign_in_diagnostic_upload = account_prepare.fetch("steps").find do |step|
  step.dig("with", "path") == "/tmp/e2e-runner-sign-in-diagnostics"
end
raise "missing runner E2E sign-in diagnostic upload" unless sign_in_diagnostic_upload
unless sign_in_diagnostic_upload.fetch("if") == "always()" &&
    sign_in_diagnostic_upload["continue-on-error"] == true &&
    sign_in_diagnostic_upload.dig("with", "path") == "/tmp/e2e-runner-sign-in-diagnostics" &&
    sign_in_diagnostic_upload.dig("with", "if-no-files-found") == "ignore" &&
    sign_in_diagnostic_upload.dig("with", "retention-days") == 1
  raise "runner E2E sign-in diagnostics must retain recovered attempts, remain best-effort, isolated from tokens, and short-lived"
end

diagnostic_upload_step = account_prepare.fetch("steps").find do |step|
  step.dig("with", "path") == "/tmp/e2e-runner-checkout-diagnostics"
end
raise "missing runner E2E Checkout diagnostic upload" unless diagnostic_upload_step
unless diagnostic_upload_step.fetch("if") == "failure()" &&
    diagnostic_upload_step.dig("with", "path") ==
      "/tmp/e2e-runner-checkout-diagnostics" &&
    diagnostic_upload_step.dig("with", "if-no-files-found") == "ignore" &&
    diagnostic_upload_step.dig("with", "retention-days") == 1
  raise "runner E2E Checkout diagnostics must be failure-only and short-lived"
end

upload_step = account_prepare.fetch("steps").find do |step|
  step.fetch("uses", "").start_with?("actions/upload-artifact@") &&
    step.dig("with", "name") == "e2e-tokens"
end
raise "missing runner E2E token artifact upload" unless upload_step
unless upload_step.dig("with", "name") == "e2e-tokens" &&
    upload_step.dig("with", "retention-days") == 1
  raise "runner E2E token artifact must retain the historical contract"
end
%w[
  e2e-api-credentials-runner-real-codex.json
  e2e-api-credentials-runner-mock-claude.json
  e2e-api-credentials-runner-real-codex-built-in.json
].each do |file_name|
  unless upload_step.dig("with", "path").include?(file_name)
    raise "runner E2E token artifact must include #{file_name}"
  end
end

unless Array(bootstrap["needs"]).include?("cli-e2e-03-runner-prepare")
  raise "runner bootstrap must wait for the token artifact"
end
bootstrap_steps = bootstrap.fetch("steps")
unless bootstrap_steps.any? do |step|
    step["uses"]&.start_with?("actions/checkout@")
  end
  raise "runner bootstrap must checkout the focused helper scripts"
end
unless bootstrap_steps.any? do |step|
    step.fetch("uses", "").start_with?("actions/download-artifact@") &&
      step.dig("with", "name") == "e2e-tokens"
  end
  raise "runner bootstrap must download the token artifact"
end
# Check fresh Auto defaults before personal subscriptions change the catalog.
auto_accounts = {
  "runner-mock-claude" => "false",
  "runner-real-codex" => "true",
  "runner-real-codex-built-in" => "true",
}
auto_accounts.each do |account, real_agent|
  command = "runner-auto-bootstrap.bash /tmp/e2e-api-credentials-#{account}.json"
  step = bootstrap_steps.find { |candidate| candidate.fetch("run", "").include?(command) }
  raise "missing #{account} bootstrap" unless step
  unless step.fetch("run").end_with?("#{command} #{real_agent}")
    raise "#{account} must bootstrap the intended runtime"
  end
  unless step.dig("env", "VERCEL_AUTOMATION_BYPASS_SECRET") ==
      "${{ secrets.VERCEL_AUTOMATION_BYPASS_SECRET }}"
    raise "#{account} bootstrap must receive the preview bypass secret"
  end
end
mock_claude_step = bootstrap_steps.find do |step|
  step.fetch("run", "").include?("runner-mock-claude-bootstrap.bash")
end
raise "missing personal subscription bootstrap" unless mock_claude_step
fresh_mock_index = bootstrap_steps.index do |step|
  step.fetch("run", "").include?(
    "runner-auto-bootstrap.bash /tmp/e2e-api-credentials-runner-mock-claude.json false",
  )
end
unless fresh_mock_index && fresh_mock_index < bootstrap_steps.index(mock_claude_step)
  raise "mock identity must verify fresh Auto defaults before installing personal subscriptions"
end
unless mock_claude_step.fetch("run").end_with?(
    "runner-mock-claude-bootstrap.bash /tmp/e2e-api-credentials-runner-mock-claude.json",
  )
  raise "personal subscription bootstrap must use the focused executable"
end
unless mock_claude_step.dig("env", "VERCEL_AUTOMATION_BYPASS_SECRET") ==
    "${{ secrets.VERCEL_AUTOMATION_BYPASS_SECRET }}"
  raise "mock subscription bootstrap must receive the preview bypass secret"
end
mock_claude_script = File.read(ARGV.fetch(1))
unless mock_claude_script.include?('.effectiveSwitches._realAgentInPreview == false')
  raise "synthetic personal credentials must only use mock runtimes"
end

unless runner.dig("env", "E2E_RUNNER_TEST_FILES_JSON") == "${{ toJSON(matrix.files) }}" &&
    runner.dig("env", "E2E_RUNNER_SHARD_TOTAL") == "${{ strategy.job-total }}"
  raise "runner E2E shards must receive their exact file list and dynamic total"
end
unless runner.dig("env", "E2E_RUNNER_MOCK_CLAUDE_ORG_ID") ==
    "${{ needs.cli-e2e-03-runner-prepare.outputs.mock-claude-organization-id }}" &&
    runner.dig("env", "E2E_RUNNER_MOCK_CLAUDE_EMAIL") ==
      "${{ needs.cli-e2e-03-runner-prepare.outputs.mock-claude-email }}"
  raise "runner E2E shards must receive the mock Claude identity"
end

run_step = runner.fetch("steps").find do |step|
  step.fetch("run", "").include?("./test/libs/bats/bin/bats")
end
raise "missing runner E2E BATS execution" unless run_step
if run_step.key?("continue-on-error")
  raise "runner E2E BATS failures must remain blocking"
end
run_script = run_step.fetch("run")
unless run_script.include?('mapfile -t test_files') &&
    run_script.include?('BATS_TEST_TIMEOUT=240 ./test/libs/bats/bin/bats') &&
    run_script.include?('"${test_files[@]}"')
  raise "runner E2E must safely execute every matrix file"
end
unless run_step.dig("env", "VERCEL_AUTOMATION_BYPASS_SECRET") ==
    "${{ secrets.VERCEL_AUTOMATION_BYPASS_SECRET }}"
  raise "runner E2E tests must receive the preview bypass secret"
end
if run_step.fetch("env").key?("OKOU_MITM_RUNNER_TOKEN")
  raise "runner E2E no longer requires privileged vendor-fallback injection"
end

unless runner.fetch("steps").any? do |step|
    step.fetch("uses", "").start_with?("actions/download-artifact@") &&
      step.dig("with", "name") == "e2e-tokens"
  end
  raise "every runner shard must download the token artifact"
end
cleanup_steps = account_cleanup.fetch("steps")
cleanup_scope_step = cleanup_steps.find do |step|
  step["id"] == "cleanup-scope"
end
raise "missing runner E2E cleanup scope" unless cleanup_scope_step
unless account_cleanup.fetch("if").include?("always()")
  raise "runner E2E account cleanup must run after shard failures"
end
unless Array(account_cleanup["needs"]).include?("cli-e2e-03-runner")
  raise "runner E2E account cleanup must wait for every shard"
end
if account_cleanup.fetch("if").include?("!= 'cancelled'")
  raise "runner E2E cleanup must run after cancelled account preparation"
end

unless cleanup_scope_step.dig("env", "PREPARE_RESULT") ==
    "${{ needs.cli-e2e-03-runner-prepare.result }}" &&
    cleanup_scope_step.dig("env", "RUNNER_RESULT") ==
      "${{ needs.cli-e2e-03-runner.result }}"
  raise "runner cleanup scope must use exact upstream results"
end
resolve_cleanup_scope = lambda do |prepare_result, runner_result|
  Tempfile.create("runner-cleanup-scope") do |output|
    stdout, stderr, status = Open3.capture3(
      {
        "GITHUB_OUTPUT" => output.path,
        "PREPARE_RESULT" => prepare_result,
        "RUNNER_RESULT" => runner_result,
      },
      "bash",
      "-c",
      cleanup_scope_step.fetch("run"),
    )
    unless status.success?
      raise "runner cleanup scope script failed: #{stdout}#{stderr}"
    end
    scope_line = File.readlines(output.path, chomp: true).find do |line|
      line.start_with?("scope=")
    end
    raise "runner cleanup scope script did not emit a scope" unless scope_line
    scope_line.delete_prefix("scope=")
  end
end
{
  ["skipped", "skipped"] => "none",
  ["failure", "skipped"] => "generation",
  ["cancelled", "success"] => "generation",
  ["success", "success"] => "run",
  ["success", "failure"] => "retain",
  ["success", "cancelled"] => "retain",
  ["success", "skipped"] => "retain",
}.each do |results, expected_scope|
  actual_scope = resolve_cleanup_scope.call(*results)
  unless actual_scope == expected_scope
    raise "#{results.join('/')} must select #{expected_scope}, got #{actual_scope}"
  end
end

cleanup_pnpm_setup_step = cleanup_steps.find do |step|
  step.fetch("uses", "").start_with?("pnpm/action-setup@")
end
cleanup_node_setup_step = cleanup_steps.find do |step|
  step.fetch("uses", "").start_with?("actions/setup-node@")
end

conditional_setup_steps = [
  cleanup_pnpm_setup_step,
  cleanup_node_setup_step,
  cleanup_steps.find { |step| step.fetch("run", "").include?("pnpm install --frozen-lockfile") },
]
unless conditional_setup_steps.all? do |step|
    step && step["if"] == "steps.cleanup-scope.outputs.scope == 'generation' || steps.cleanup-scope.outputs.scope == 'run'"
  end
  raise "retained or absent accounts must skip dependency setup"
end

unless Array(account_cleanup["needs"]).include?("cli-e2e-02-playwright") &&
    Array(account_cleanup["needs"]).include?("deploy-runner-start")
  raise "idle cleanup must wait for every shared Runner consumer"
end
shared_runner_consumers = jobs.select do |id, job|
  Array(job["needs"]).include?("deploy-runner-start") &&
    !["cli-e2e-03-runner-cleanup", "ci-gate-turbo"].include?(id)
end.keys
unless (shared_runner_consumers - Array(account_cleanup["needs"])).empty?
  raise "every preview Runner consumer must finish before idle cleanup: #{shared_runner_consumers}"
end
unless account_cleanup.fetch("if").include?("needs.deploy-runner-start.result == 'success'")
  raise "Playwright-only Runner deployments must remain eligible for cleanup"
end
checkout = cleanup_steps.find { |step| step.fetch("uses", "").start_with?("actions/checkout@") }
raise "idle cleanup needs checkout even with retained accounts" if checkout.key?("if")
prune_ssh_step = cleanup_steps.find { |step| step["uses"] == "./.github/actions/setup-ssh-tunnel" }
unless prune_ssh_step &&
    prune_ssh_step["if"] == "always() && needs.deploy-runner-start.result == 'success'" &&
    prune_ssh_step.dig("with", "ssh-hosts") == "${{ fromJSON(needs.deploy-runner-start.outputs.runner-receipt).host }}"
  raise "idle cleanup must preconnect only its deployed host, independently of unrelated host availability"
end
prune_step = cleanup_steps.find { |step| step.fetch("run", "").include?("prune-runner-idle.sh") }
unless prune_step && prune_step["if"] == "always() && needs.deploy-runner-start.result == 'success'" &&
    prune_step.dig("env", "RUNNER_RECEIPT") == "${{ needs.deploy-runner-start.outputs.runner-receipt }}"
  raise "idle cleanup must use the captured deployment receipt independently of account cleanup"
end

generation_cleanup_step = cleanup_steps.find do |step|
  step.fetch("run", "").include?("runner-account.ts cleanup-recorded-generation")
end
run_cleanup_step = cleanup_steps.find do |step|
  step.fetch("run", "").include?("runner-account.ts cleanup-recorded-run")
end
unless generation_cleanup_step &&
    generation_cleanup_step["if"] ==
      "steps.cleanup-scope.outputs.scope == 'generation'" &&
    generation_cleanup_step.fetch("run").end_with?(
      "runner-account.ts cleanup-recorded-generation",
    )
  raise "incomplete preparation must reconcile only the current generation"
end
unless run_cleanup_step &&
    run_cleanup_step["if"] == "steps.cleanup-scope.outputs.scope == 'run'" &&
    run_cleanup_step.fetch("run").end_with?("runner-account.ts cleanup-recorded-run")
  raise "successful runner work must reconcile the exact workflow run"
end
%w[
  E2E_RUNNER_ORGANIZATION_ID
  E2E_RUNNER_CODEX_ORGANIZATION_ID
  E2E_RUNNER_CLAUDE_ORGANIZATION_ID
  E2E_RUNNER_MOCK_CLAUDE_ORGANIZATION_ID
].each do |environment_name|
  if [generation_cleanup_step, run_cleanup_step].any? do |step|
      step.fetch("env", {}).key?(environment_name)
    end
    raise "runner E2E cleanup must not depend on #{environment_name}"
  end
end

gate_needs = Array(jobs.fetch("ci-gate-turbo")["needs"])
%w[
  cli-e2e-02-playwright
  cli-e2e-03-runner-prepare
  cli-e2e-03-runner-bootstrap
  cli-e2e-03-runner
].each do |job_name|
  raise "CI gate must include #{job_name}" unless gate_needs.include?(job_name)
end
%w[
  cli-e2e-02-playwright-finalize
  cli-e2e-03-runner-cleanup
].each do |job_name|
  raise "CI gate must not wait for #{job_name}" if gate_needs.include?(job_name)
end

RUBY

echo "turbo-playwright-runner-workflow-test: ok"
