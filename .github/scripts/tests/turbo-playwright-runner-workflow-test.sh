#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
WORKFLOW="${REPO_ROOT}/.github/workflows/turbo.yml"
TURBO_CONFIG="${REPO_ROOT}/turbo/turbo.json"
RUNNER_START_HELPER="${REPO_ROOT}/.github/scripts/reconcile-and-start-runner-groups.sh"
RUNNER_TESTS="${REPO_ROOT}/e2e/tests/03-runner"
REAL_CLAUDE_TEST="${RUNNER_TESTS}/run-t10-real-claude-smoke.bats"
BUILT_IN_FALLBACK_TEST="${RUNNER_TESTS}/run-t24-built-in-provider-fallback.bats"
RUNNER_HELPERS=(
  "${REPO_ROOT}/e2e/helpers/runner-api.bash"
  "${REPO_ROOT}/e2e/helpers/runner-chat.bash"
)
RUNNER_TOKEN="${REPO_ROOT}/e2e/playwright/runner-token.ts"
RUNNER_MOCK_CLAUDE_BOOTSTRAP="${REPO_ROOT}/e2e/playwright/runner-mock-claude-bootstrap.bash"
PLAYWRIGHT_CONFIG="${REPO_ROOT}/e2e/playwright/playwright.config.ts"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

api_backend_url_key_count="$(
  jq \
    '[.globalEnv[] | select(. == "OKOU_API_BACKEND_URL")] | length' \
    "$TURBO_CONFIG"
)"
if [[ "$api_backend_url_key_count" -ne 1 ]]; then
  fail "Turbo must pass through the E2E API backend URL exactly once"
fi

grep -Fq ".github/scripts/reconcile-and-start-runner-groups.sh" "$WORKFLOW" ||
  fail "runner deployment must invoke the lifecycle-locked start helper"
grep -Fq "local RUNNER_DIRNAME=\"\${RUNNER_DIR##*/}\"" "$RUNNER_START_HELPER" ||
  fail "runner config dirname must come from the manifest runner directory"
grep -Fq -- "--runner-dirname \${RUNNER_DIRNAME}" "$RUNNER_START_HELPER" ||
  fail "runner config must be written beneath the manifest runner directory"
grep -Fq -- "--hostname \${HOST}" "$RUNNER_START_HELPER" ||
  fail "runner config must use the metal host for attribution"
grep -Fq -- "--config \${RUNNER_DIR}/runner.yaml" "$RUNNER_START_HELPER" ||
  fail "runner service must read the config from the manifest runner directory"
if grep -Fq -- "--runner-dirname \${RUNNER_SERVICE_REF}" "$RUNNER_START_HELPER"; then
  fail "runner service identity must not select the manifest config directory"
fi
grep -Fq "RUNNER_SERVICE_REF: \${{ needs.prepare.outputs.job-ref }}" "$WORKFLOW" ||
  fail "runner service identity must follow the deployed API job ref"
grep -Fq "RUNNER_GROUP: \${{ format('vm0/development-{0}', needs.prepare.outputs.job-ref) }}" "$WORKFLOW" ||
  fail "runner group must match the deployed API default group"
if grep -Fq 'playwright-staging' "$WORKFLOW"; then
  fail "main Playwright runs must not use a group outside the staging API default"
fi
grep -Fq '["list"]' "$PLAYWRIGHT_CONFIG" ||
  fail "Playwright CI must retain human-readable list reporting"
grep -Fq '["blob", { outputDir: "blob-report" }]' "$PLAYWRIGHT_CONFIG" ||
  fail "Playwright CI must emit mergeable blob reports"
grep -Fq 'name: "auth-v1"' "$PLAYWRIGHT_CONFIG" ||
  fail "Playwright must register the dedicated Auth v1 project"
grep -Fq 'testMatch: "auth-v1.spec.ts"' "$PLAYWRIGHT_CONFIG" ||
  fail "the auth project must cover the hosted Clerk auth spec without unrelated specs"
grep -Fq 'workers: 1' "$PLAYWRIGHT_CONFIG" ||
  fail "the Auth v1 project must use one worker"
grep -Fq 'trace: "off"' "$PLAYWRIGHT_CONFIG" ||
  fail "the Auth v1 project must not retain credential-bearing traces"
grep -Fq 'process.env.PLAYWRIGHT_PROJECT !== "auth-v1"' "$PLAYWRIGHT_CONFIG" ||
  fail "the Auth v1 project must not retain credential-bearing blob reports"
grep -Fq "if: always() && matrix.project != 'auth-v1'" "$WORKFLOW" ||
  fail "the Auth v1 lane must not upload a Playwright blob report"
if grep -R -Fq '/api/test/' "$RUNNER_TESTS" "${RUNNER_HELPERS[@]}"; then
  fail "runner E2E coverage must use supported public APIs"
fi
grep -Fq 'REAL_CLAUDE_MODEL="claude-sonnet-5"' "$REAL_CLAUDE_TEST" ||
  fail "real Claude E2E must select Sonnet 5"
if [[ "$(grep -Fc "\"\$REAL_CLAUDE_MODEL\"" "$REAL_CLAUDE_TEST")" -ne 3 ]]; then
  fail "real Claude E2E must use its model pin for policy, smoke, and steer coverage"
fi
if grep -Fq 'claude-sonnet-4-6' "$REAL_CLAUDE_TEST"; then
  fail "real Claude E2E must not retain the Sonnet 4.6 pin"
fi
grep -Fq 'OKOU_MITM_RUNNER_TOKEN' "$BUILT_IN_FALLBACK_TEST" ||
  fail "built-in fallback E2E must require trusted failure authentication"
grep -Fq 'createRunnerCheckout' "$RUNNER_TOKEN" ||
  fail "paid runner accounts must use the public checkout API"
grep -Fq 'fillStripeCheckout' "$RUNNER_TOKEN" ||
  fail "real runner accounts must complete the public Stripe checkout"
if [[ "$(grep -Fc 'upgradeToPro: true' "$RUNNER_TOKEN")" -ne 3 ]]; then
  fail "real Codex, real Claude, and mock Claude runner accounts must upgrade to Pro"
fi
if [[ "$(grep -Fc 'upgradeToPro: false' "$RUNNER_TOKEN")" -ne 1 ]]; then
  fail "the default mock runner account must remain on limited-free"
fi

ruby -ryaml -ropen3 -rtempfile - "$WORKFLOW" "$RUNNER_MOCK_CLAUDE_BOOTSTRAP" <<'RUBY'
workflow = YAML.load_file(ARGV.fetch(0))
jobs = workflow.fetch("jobs")
expected_deployed_ref =
  "${{ github.event_name == 'pull_request' && github.event.pull_request.head.sha || github.sha }}"
# Account/shard preparation, execution, reports, and cleanup must all consume
# the API/CLI revision, including any future E2E lifecycle job.
jobs.each do |job_name, job|
  next unless job_name.start_with?("cli-e2e-") ||
    %w[deploy-api deploy-cli].include?(job_name)

  checkouts = job.fetch("steps").select do |step|
    step.fetch("uses", "").start_with?("actions/checkout@")
  end
  unless checkouts.length == 1 &&
      checkouts.first.dig("with", "ref") == expected_deployed_ref
    raise "#{job_name} must checkout the deployed PR head, or event SHA outside pull requests"
  end
end
prepare = jobs.fetch("prepare")
stripe_listener = jobs.fetch("deploy-stripe-listener")
browser = jobs.fetch("cli-e2e-02-browser")
playwright = jobs.fetch("cli-e2e-02-playwright")
playwright_finalizer = jobs.fetch("cli-e2e-02-playwright-finalize")
account_prepare = jobs.fetch("cli-e2e-03-runner-prepare")
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
  step["name"] == "Run browser E2E tests"
end
raise "missing browser E2E execution" unless browser_run
if browser_run["continue-on-error"] || browser["continue-on-error"]
  raise "browser E2E failures must remain blocking"
end
assert_canonical_api_backend_url.call(browser_run, "browser E2E")
pnpm_setup_action =
  "pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86"
pnpm_version = "10.33.4"
{
  "runner E2E preparation" => account_prepare,
  "runner E2E shards" => runner,
  "runner E2E cleanup" => account_cleanup,
}.each do |job_name, job|
  steps = job.fetch("steps")
  pnpm_setup_index = steps.index do |step|
    step["uses"] == pnpm_setup_action
  end
  node_setup_index = steps.index do |step|
    step.fetch("uses", "").start_with?("actions/setup-node@")
  end
  unless pnpm_setup_index && node_setup_index &&
      pnpm_setup_index < node_setup_index
    raise "#{job_name} must install pnpm before selecting Node.js 22"
  end
  pnpm_setup_step = steps.fetch(pnpm_setup_index)
  unless pnpm_setup_step.dig("with", "version") == pnpm_version
    raise "#{job_name} must install the pinned pnpm version"
  end
  if steps.any? do |step|
      step.fetch("run", "").include?("corepack enable pnpm")
    end
    raise "#{job_name} must not download pnpm through Node.js 22 Corepack"
  end
  dependency_install = steps.find do |step|
    step["name"] == "Install E2E dependencies"
  end
  unless dependency_install&.fetch("run", nil) ==
      "cd e2e && pnpm install --frozen-lockfile"
    raise "#{job_name} must keep the frozen E2E dependency install"
  end
end

playwright_step_names = playwright.fetch("steps").map { |step| step["name"] }
browser_install_index = playwright_step_names.index("Install Playwright browsers")
fixture_test_index = playwright_step_names.index(
  "Run Playwright fixture integration tests",
)
unless browser_install_index && fixture_test_index &&
    browser_install_index < fixture_test_index
  raise "Playwright browsers must be installed before browser fixture tests"
end

unless playwright.dig("strategy", "fail-fast") == false
  raise "Playwright project lanes must not fail fast"
end
expected_playwright_lanes = [
  { "lane" => "features", "project" => "features" },
  { "lane" => "paid-onboarding", "project" => "paid-onboarding" },
  { "lane" => "auth-v1", "project" => "auth-v1" },
]
unless playwright.dig("strategy", "matrix", "include") ==
    expected_playwright_lanes
  raise "Playwright matrix must contain the expected project lanes"
end
expected_playwright_group =
  "cli-e2e-02-playwright-${{ matrix.lane }}-${{ needs.prepare.outputs.job-ref }}"
unless playwright.dig("concurrency", "group") == expected_playwright_group
  raise "each Playwright lane must keep an independent concurrency group"
end
unless playwright.dig("concurrency", "cancel-in-progress") == true
  raise "superseding runs must cancel only their matching Playwright lane"
end
playwright_run = playwright.fetch("steps").find do |step|
  step["name"] == "Run Playwright E2E tests"
end
unless playwright_run&.fetch("shell") == "bash" &&
    !playwright_run["continue-on-error"] && !playwright["continue-on-error"] &&
    playwright_run.fetch("run").include?('--project="$PLAYWRIGHT_PROJECT"') &&
    playwright_run.dig("env", "PLAYWRIGHT_PROJECT") ==
      "${{ matrix.project }}"
  raise "each Playwright lane must select its matrix project"
end
assert_canonical_api_backend_url.call(playwright_run, "Playwright E2E")
unless playwright_run.fetch("run").include?(
    'if [[ "$PLAYWRIGHT_PROJECT" == "auth-v1" ]]',
  ) && playwright_run.fetch("run").include?("__clerk_db_jwt") &&
    playwright_run.fetch("run").include?("masked-clerk-test-email") &&
    playwright_run.fetch("run").include?("masked-clerk-resource-id") &&
    playwright_run.fetch("run").include?("sess|user|org|sia|sua") &&
    playwright_run.fetch("run").include?("set -o pipefail")
  raise "the Auth v1 lane must redact Clerk secrets and identifiers"
end
playwright_blob_upload = playwright.fetch("steps").find do |step|
  step["name"] == "Upload Playwright blob report"
end
unless playwright_blob_upload &&
    playwright_blob_upload.fetch("if") ==
      "always() && matrix.project != 'auth-v1'" &&
    playwright_blob_upload.dig("with", "name") ==
      "playwright-blob-${{ matrix.lane }}" &&
    playwright_blob_upload.dig("with", "path") ==
      "e2e/playwright/blob-report/"
  raise "non-sensitive Playwright lanes must upload uniquely named blob reports"
end

unless Array(playwright_finalizer["needs"]).include?("cli-e2e-02-playwright")
  raise "Playwright report finalizer must wait for every matrix lane"
end
finalizer_steps = playwright_finalizer.fetch("steps")
download_index = finalizer_steps.index do |step|
  step["name"] == "Download Playwright blob reports"
end
merge_index = finalizer_steps.index do |step|
  step["name"] == "Merge Playwright HTML report"
end
upload_index = finalizer_steps.index do |step|
  step["name"] == "Upload Playwright HTML report"
end
unless download_index && merge_index && upload_index &&
    download_index < merge_index && merge_index < upload_index
  raise "Playwright finalizer must download, merge, then upload reports"
end
download_step = finalizer_steps.fetch(download_index)
unless download_step.dig("with", "pattern") == "playwright-blob-*" &&
    download_step.dig("with", "merge-multiple") == true
  raise "Playwright finalizer must combine every lane blob artifact"
end
merge_step = finalizer_steps.fetch(merge_index)
unless merge_step.fetch("run").include?(
    "playwright merge-reports --reporter=html all-blob-reports",
  )
  raise "Playwright finalizer must build one HTML report from lane blobs"
end
upload_step = finalizer_steps.fetch(upload_index)
unless upload_step.fetch("if") == "always()" &&
    upload_step.dig("with", "name") == "playwright-report" &&
    upload_step.dig("with", "path") == "e2e/playwright-report/"
  raise "Playwright finalizer must always publish the merged HTML report"
end

expected_browser_install =
  "cd e2e && pnpm exec playwright install --only-shell chromium"
{
  "Playwright E2E" => playwright,
  "runner E2E preparation" => account_prepare,
}.each do |job_name, job|
  install_step = job.fetch("steps").find do |step|
    step["name"] == "Install Playwright browsers"
  end
  unless install_step&.fetch("run", nil) == expected_browser_install
    raise "#{job_name} must install only the Chromium headless shell"
  end
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
  deploy-cli
  deploy-runner-prepare
  deploy-runner-start
  cli-e2e-03-runner-prepare
  cli-e2e-03-runner-bootstrap
]
unless required_needs.all? { |job_name| Array(runner["needs"]).include?(job_name) }
  raise "runner E2E shards must wait for accounts, API, CLI, and runner deployment"
end

unless runner.fetch("if").include?("needs.deploy-cli.result == 'success'")
  raise "runner E2E shards must require a published CLI artifact"
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
  step["name"] == "Prepare runner E2E accounts"
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
  "runner-organization-id" => "runner-organization-id",
  "codex-organization-id" => "codex-organization-id",
  "claude-organization-id" => "claude-organization-id",
  "mock-claude-organization-id" => "mock-claude-organization-id",
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
  step["name"] == "Generate runner E2E shard matrix"
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
  step["name"] == "Generate runner E2E API tokens"
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

diagnostic_upload_step = account_prepare.fetch("steps").find do |step|
  step["name"] == "Upload runner E2E Checkout diagnostics"
end
raise "missing runner E2E Checkout diagnostic upload" unless diagnostic_upload_step
unless diagnostic_upload_step.fetch("if") == "failure()" &&
    diagnostic_upload_step.dig("with", "name") ==
      "runner-e2e-checkout-diagnostics" &&
    diagnostic_upload_step.dig("with", "path") ==
      "/tmp/e2e-runner-checkout-diagnostics" &&
    diagnostic_upload_step.dig("with", "if-no-files-found") == "ignore" &&
    diagnostic_upload_step.dig("with", "retention-days") == 1
  raise "runner E2E Checkout diagnostics must be failure-only and short-lived"
end

upload_step = account_prepare.fetch("steps").find do |step|
  step["name"] == "Upload runner E2E API tokens"
end
raise "missing runner E2E token artifact upload" unless upload_step
unless upload_step.dig("with", "name") == "e2e-tokens" &&
    upload_step.dig("with", "retention-days") == 1
  raise "runner E2E token artifact must retain the historical contract"
end
%w[
  e2e-api-credentials-runner.json
  e2e-api-credentials-runner-real-codex.json
  e2e-api-credentials-runner-real-claude.json
  e2e-api-credentials-runner-mock-claude.json
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
    step["name"] == "Download runner E2E API tokens" &&
      step.dig("with", "name") == "e2e-tokens"
  end
  raise "runner bootstrap must download the token artifact"
end
model_defaults_step = bootstrap_steps.find do |step|
  step["name"] == "Reset runner model defaults"
end
raise "missing runner model policy bootstrap" unless model_defaults_step
model_defaults_script = model_defaults_step.fetch("run")
unless model_defaults_script.include?("/api/model-policies") &&
    model_defaults_script.include?("/api/user-model-preference") &&
    model_defaults_script.include?("deepseek-v4-flash") &&
    model_defaults_script.include?("gpt-5.6-luna") &&
    model_defaults_script.scan('defaultProviderType: "built-in"').length == 2 &&
    model_defaults_script.include?('{"selectedModel":null,"serviceTier":null}')
  raise "runner bootstrap must reset the limited-free model defaults"
end
%w[claude-opus-4-7 claude-sonnet-4-6 gpt-5.5].each do |restricted_model|
  if model_defaults_script.include?(restricted_model)
    raise "runner bootstrap must not select restricted model #{restricted_model}"
  end
end
provider_step = bootstrap_steps.find do |step|
  step["name"] == "Bootstrap runner mock model provider"
end
raise "missing runner mock provider bootstrap" unless provider_step
unless provider_step.fetch("run").include?(
    '{"type":"claude-code-oauth-token","secret":"mock-oauth-token-for-e2e"}',
  )
  raise "runner bootstrap must restore the historical mock provider"
end
mock_claude_step = bootstrap_steps.find do |step|
  step["name"] == "Bootstrap mock Claude account"
end
raise "missing mock Claude account bootstrap" unless mock_claude_step
unless mock_claude_step.fetch("run").end_with?(
    "runner-mock-claude-bootstrap.bash /tmp/e2e-api-credentials-runner-mock-claude.json",
  )
  raise "mock Claude account bootstrap must use the focused executable"
end
unless mock_claude_step.dig("env", "VERCEL_AUTOMATION_BYPASS_SECRET") ==
    "${{ secrets.VERCEL_AUTOMATION_BYPASS_SECRET }}"
  raise "mock Claude bootstrap must receive the preview bypass secret"
end
mock_claude_script = File.read(ARGV.fetch(1))
%w[
  /api/me/model-providers
  /api/model-policies
  /api/feature-switches
  claude-code-oauth-token
  claude-sonnet-4-6
  _realAgentInPreview
].each do |required_fragment|
  unless mock_claude_script.include?(required_fragment)
    raise "mock Claude bootstrap must include #{required_fragment}"
  end
end
unless mock_claude_script.include?(
    '.effectiveSwitches._realAgentInPreview == false',
  )
  raise "mock Claude bootstrap must keep the real runtime disabled"
end
unless mock_claude_script.include?('credentialScope: "member"') &&
    mock_claude_script.include?("modelProviderId: null")
  raise "mock Claude OAuth policy must use member credentials"
end
codex_step = bootstrap_steps.find do |step|
  step["name"] == "Bootstrap real Codex account"
end
raise "missing real Codex account bootstrap" unless codex_step
codex_script = codex_step.fetch("run")
%w[
  /api/model-providers
  /api/model-policies
  /api/feature-switches
  gpt-5.6-luna
  _realAgentInPreview
].each do |required_fragment|
  unless codex_script.include?(required_fragment)
    raise "real Codex bootstrap must include #{required_fragment}"
  end
end
unless codex_step.dig("env", "OPENAI_API_KEY") ==
    "${{ secrets.OPENAI_API_KEY }}"
  raise "real Codex bootstrap must receive the OpenAI credential"
end
claude_step = bootstrap_steps.find do |step|
  step["name"] == "Bootstrap real Claude account"
end
raise "missing real Claude account bootstrap" unless claude_step
claude_script = claude_step.fetch("run")
%w[
  /api/model-policies
  /api/feature-switches
  _realAgentInPreview
].each do |required_fragment|
  unless claude_script.include?(required_fragment)
    raise "real Claude bootstrap must include #{required_fragment}"
  end
end
unless claude_script.include?('claude_model="claude-sonnet-5"') &&
    claude_script.include?('--arg model "$claude_model"') &&
    claude_script.include?('select(.model != $model)') &&
    claude_script.include?('model: $model')
  raise "real Claude bootstrap must configure Sonnet 5 consistently"
end
if claude_script.include?("claude-sonnet-4-6")
  raise "real Claude bootstrap must not retain the Sonnet 4.6 pin"
end
unless claude_script.include?('defaultProviderType: "built-in"') &&
    claude_script.include?("modelProviderId: null")
  raise "real Claude bootstrap must use the built-in provider"
end

shard_step = runner.fetch("steps").find do |step|
  step["name"] == "Initialize runner E2E shard"
end
raise "missing runner E2E shard scaffold" unless shard_step
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
  step.fetch("name", "").include?("Run runner E2E tests")
end
raise "missing runner E2E BATS execution" unless run_step
if run_step.key?("continue-on-error")
  raise "runner E2E BATS failures must remain blocking"
end
run_script = run_step.fetch("run")
unless run_script.include?('mapfile -t test_files') &&
    run_script.include?('BATS_TEST_TIMEOUT=240 ./test/libs/bats/bin/bats') &&
    run_script.include?('--report-formatter junit') &&
    run_script.include?('"${test_files[@]}"')
  raise "runner E2E must safely execute every matrix file with JUnit reporting"
end
unless run_step.dig("env", "VERCEL_AUTOMATION_BYPASS_SECRET") ==
    "${{ secrets.VERCEL_AUTOMATION_BYPASS_SECRET }}"
  raise "runner E2E tests must receive the preview bypass secret"
end
expected_failure_token = "${{ contains(matrix.files, 'tests/03-runner/run-t24-built-in-provider-fallback.bats') && format('vm0_official_{0}', secrets.OFFICIAL_RUNNER_SECRET) || '' }}"
unless run_step.dig("env", "OKOU_MITM_RUNNER_TOKEN") == expected_failure_token
  raise "only the built-in fallback shard may receive trusted failure authentication"
end
unless runner.fetch("steps").any? do |step|
    step["name"] == "Download runner E2E API tokens" &&
      step.dig("with", "name") == "e2e-tokens"
  end
  raise "every runner shard must download the token artifact"
end
unless runner.fetch("steps").any? do |step|
    step["name"] == "Upload runner E2E JUnit XML" &&
      step["continue-on-error"] == true &&
      step["if"] == "${{ !cancelled() }}" &&
      step.dig("with", "name") == "e2e-runner-junit-${{ matrix.index }}" &&
      step.dig("with", "path") == "e2e/results/runner-${{ matrix.index }}/" &&
      step.dig("with", "retention-days") == 7
  end
  raise "every runner shard must attempt a non-blocking JUnit upload unless cancelled"
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

retain_step = cleanup_steps.find do |step|
  step["name"] == "Retain runner E2E accounts for failed-job rerun"
end
unless retain_step &&
    retain_step["if"] == "steps.cleanup-scope.outputs.scope == 'retain'" &&
    retain_step.fetch("run").include?("successful rerun or fallback cleanup")
  raise "failed runner work must retain reusable accounts explicitly"
end

cleanup_pnpm_setup_step = cleanup_steps.find do |step|
  step["uses"] == pnpm_setup_action
end
cleanup_node_setup_step = cleanup_steps.find do |step|
  step.fetch("uses", "").start_with?("actions/setup-node@")
end

conditional_setup_steps = [
  cleanup_pnpm_setup_step,
  cleanup_node_setup_step,
  cleanup_steps.find { |step| step["name"] == "Install E2E dependencies" },
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
prune_ssh_step = cleanup_steps.find { |step| step["name"] == "Setup SSH for idle sandbox cleanup" }
unless prune_ssh_step &&
    prune_ssh_step["if"] == "always() && needs.deploy-runner-start.result == 'success'" &&
    prune_ssh_step.dig("with", "ssh-hosts") == "${{ fromJSON(needs.deploy-runner-start.outputs.runner-receipt).host }}"
  raise "idle cleanup must preconnect only its deployed host, independently of unrelated host availability"
end
prune_step = cleanup_steps.find { |step| step["name"] == "Reclaim exact idle sandboxes from the deployed runner" }
unless prune_step && prune_step["if"] == "always() && needs.deploy-runner-start.result == 'success'" &&
    prune_step.dig("env", "RUNNER_RECEIPT") == "${{ needs.deploy-runner-start.outputs.runner-receipt }}"
  raise "idle cleanup must use the captured deployment receipt independently of account cleanup"
end

generation_cleanup_step = cleanup_steps.find do |step|
  step["name"] == "Cleanup current runner E2E generation"
end
run_cleanup_step = cleanup_steps.find do |step|
  step["name"] == "Cleanup runner E2E workflow run"
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

gate_step = jobs.fetch("ci-gate-turbo").fetch("steps").find do |step|
  step["name"] == "Validate CI results"
end
raise "missing Turbo CI gate validation" unless gate_step
gate_script = gate_step.fetch("run")
if gate_script.include?('[ "$result" = "cancelled" ]') ||
    gate_script.include?("cancelled by concurrency group, allowed")
  raise "CI gate must reject cancelled required jobs"
end
unless gate_script.include?("RUNNER_E2E_SKIP_ALLOWED=\"true\"") &&
    gate_script.include?("needs.prepare.outputs.turbo-runner-consumer-needed")
  raise "CI gate must restore the runner-specific E2E skip policy"
end
%w[
  cli-e2e-03-runner-prepare
  cli-e2e-03-runner-bootstrap
  cli-e2e-03-runner
].each do |job_name|
  expected = "check_result \"#{job_name}\" \"${{ needs.#{job_name}.result }}\" \"$RUNNER_E2E_SKIP_ALLOWED\""
  raise "CI gate must check #{job_name} with RUNNER_E2E_SKIP_ALLOWED" unless gate_script.include?(expected)
end
%w[
  cli-e2e-02-browser
  cli-e2e-02-playwright
].each do |job_name|
  expected = "check_result \"#{job_name}\" \"${{ needs.#{job_name}.result }}\" \"true\""
  raise "CI gate must reject failed or cancelled #{job_name}" unless gate_script.include?(expected)
end
%w[
  cli-e2e-02-playwright-finalize
  cli-e2e-03-runner-cleanup
].each do |job_name|
  if gate_script.include?("needs.#{job_name}.result")
    raise "CI gate must not evaluate #{job_name}"
  end
end
RUBY

echo "turbo-playwright-runner-workflow-test: ok"
