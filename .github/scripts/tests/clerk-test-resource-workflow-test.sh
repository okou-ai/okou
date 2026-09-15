#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../../.." && pwd)"
browser_helper="${repo_root}/e2e/helpers/browser.bash"
browser_test="${repo_root}/e2e/tests/02-browser/brw-t01-platform-e2e.bats"

generated_email="$(
  JOB_REF="pr-123" \
    GITHUB_RUN_ID="8000" \
    GITHUB_RUN_ATTEMPT="2" \
    bash -c 'source "$1"; generate_test_email' _ "$browser_helper"
)"
if [[ "$generated_email" != "pr-123+clerk_test+8000-2+browser@vm0-e2e.ai" ]]; then
  echo "browser helper did not generate the canonical account" >&2
  exit 1
fi
if JOB_REF="invalid_ref" bash -c \
  'source "$1"; generate_test_email' _ "$browser_helper" >/dev/null 2>&1; then
  echo "browser helper accepted a JOB_REF that its cleanup rejects" >&2
  exit 1
fi

canonical_api_url="https://canonical.example.test/Exact/Path/?query=a%20b#fragment"
# The child shell, not this test process, expands the quoted assertions.
# shellcheck disable=SC2016
if ! OKOU_API_BACKEND_URL="$canonical_api_url" \
  EXPECTED_API_BACKEND_URL="$canonical_api_url" \
  bash -c '
    source "$1"
    resolve_e2e_api_backend_url
    [[ "$E2E_API_BACKEND_URL" == "$EXPECTED_API_BACKEND_URL" ]]
  ' _ "$browser_helper"; then
  echo "browser helper did not preserve the canonical-only API URL" >&2
  exit 1
fi

expected_missing_api_url="E2E API backend URL is required: canonical_key=OKOU_API_BACKEND_URL state=missing"
api_url_status=0
# The child shell expands the quoted helper path after bash receives it.
# shellcheck disable=SC2016
missing_api_url_output="$(
  env -u OKOU_API_BACKEND_URL \
    bash -c 'source "$1"; resolve_e2e_api_backend_url' \
    _ "$browser_helper" 2>&1
)" || api_url_status=$?
if [[ "$api_url_status" -ne 1 || "$missing_api_url_output" != "$expected_missing_api_url" ]]; then
  echo "browser helper did not reject an absent API URL with a fixed diagnostic" >&2
  exit 1
fi

api_url_status=0
empty_api_url_output="$(
  OKOU_API_BACKEND_URL="" \
    bash -c 'source "$1"; resolve_e2e_api_backend_url' \
    _ "$browser_helper" 2>&1
)" || api_url_status=$?
if [[ "$api_url_status" -ne 1 || "$empty_api_url_output" != "$expected_missing_api_url" ]]; then
  echo "browser helper did not reject an empty API URL with a fixed diagnostic" >&2
  exit 1
fi

first_factor_barrier="$(
  bash -c '
    source "$1"
    wait_for_browser_target() {
      printf "%s\n" "$*"
    }
    wait_for_sign_in_email_code_ready
  ' _ "$browser_helper"
)"
for required_state in \
  "firstFactorVerification" \
  "strategy === 'email_code'" \
  "status === 'unverified'"; do
  if [[ "$first_factor_barrier" != *"$required_state"* ]]; then
    echo "browser helper does not wait for prepared email-code first factor" >&2
    exit 1
  fi
done

browser_page_call_log="$(mktemp)"
otp_call_log="$(mktemp)"
consent_call_log="$(mktemp)"
next_step_call_log="$(mktemp)"
api_url_side_effect_log="$(mktemp)"
trap 'rm -f "$browser_page_call_log" "$otp_call_log" "$consent_call_log" "$next_step_call_log" "$api_url_side_effect_log"' EXIT

api_url_status=0
# The child shell, not this test process, expands the quoted side-effect log.
# shellcheck disable=SC2016
missing_setup_output="$(
  env -u OKOU_API_BACKEND_URL \
    API_URL_SIDE_EFFECT_LOG="$api_url_side_effect_log" \
    bash -c '
      source "$1"
      agent-browser() {
        printf "called\n" >> "$API_URL_SIDE_EFFECT_LOG"
      }
      browser_setup
    ' _ "$browser_helper" 2>&1
)" || api_url_status=$?
if [[ "$api_url_status" -ne 1 || "$missing_setup_output" != "$expected_missing_api_url" ]]; then
  echo "browser setup did not fail closed on an absent API URL" >&2
  exit 1
fi
if [[ -s "$api_url_side_effect_log" ]]; then
  echo "browser setup reached agent-browser before rejecting an absent API URL" >&2
  exit 1
fi

api_url_status=0
# The child shell, not this test process, expands the quoted side-effect log.
# shellcheck disable=SC2016
empty_setup_output="$(
  OKOU_API_BACKEND_URL="" \
    API_URL_SIDE_EFFECT_LOG="$api_url_side_effect_log" \
    bash -c '
      source "$1"
      agent-browser() {
        printf "called\n" >> "$API_URL_SIDE_EFFECT_LOG"
      }
      browser_setup
    ' _ "$browser_helper" 2>&1
)" || api_url_status=$?
if [[ "$api_url_status" -ne 1 || "$empty_setup_output" != "$expected_missing_api_url" ]]; then
  echo "browser setup did not fail closed on an empty API URL" >&2
  exit 1
fi
if [[ -s "$api_url_side_effect_log" ]]; then
  echo "browser setup reached agent-browser before rejecting an empty API URL" >&2
  exit 1
fi

OKOU_API_BACKEND_URL="https://api.example.com" \
  BROWSER_PAGE_CALL_LOG="$browser_page_call_log" \
  bash -c '
    source "$1"
    active_page="blank"
    tab_listing="initial"
    agent-browser() {
      printf "%s\n" "$*" >> "$BROWSER_PAGE_CALL_LOG"
      case "$*" in
        "--json tab")
          case "$tab_listing" in
            initial)
              printf "%s\n" '\''{"success":true,"data":{"tabs":[{"active":true,"index":7,"url":"about:blank"}]}}'\''
              ;;
            stolen)
              printf "%s\n" '\''{"success":true,"data":{"tabs":[{"active":false,"index":7,"url":"https://app.example.com/sign-up"},{"active":true,"index":8,"url":"about:blank"}]}}'\''
              ;;
            missing)
              printf "%s\n" '\''{"success":true,"data":{"tabs":[{"active":true,"index":8,"url":"about:blank"}]}}'\''
              ;;
          esac
          ;;
        "tab 7")
          active_page="owned"
          ;;
        "eval "*)
          [[ "$active_page" == "owned" ]] && printf "true\n" || printf "false\n"
          ;;
      esac
    }
    browser_setup
    BROWSER_PAGE_URL="https://app.example.com/sign-up"
    active_page="blank"
    tab_listing="stolen"
    wait_for_browser_target --timeout-seconds 1 --fn "window.__ready"
    tab_listing="missing"
    if agent_browser_on_page eval "window.__ready" 2>/dev/null; then
      echo "browser helper accepted a missing owned page" >&2
      exit 1
    fi
  ' _ "$browser_helper"
expected_browser_page_calls=$'set viewport 1920 1080\n--json tab\n--json tab\ntab 7\neval Boolean(window.__ready)\n--json tab'
if [[ "$(<"$browser_page_call_log")" != "$expected_browser_page_calls" ]]; then
  echo "browser helper must restore its captured page before inspection" >&2
  exit 1
fi

OTP_CALL_LOG="$otp_call_log" bash -c '
  source "$1"
  wait_for_browser_target() {
    return 0
  }
  agent-browser() {
    printf "%s\n" "$*" >> "$OTP_CALL_LOG"
    if [[ "$1" == "tab" ]]; then
      return 0
    fi
    if [[ "$1" == "get" && "$2" == "count" ]]; then
      printf "1\n"
    fi
  }
  BROWSER_PAGE_INDEX=0
  enter_otp "424242"
' _ "$browser_helper"
expected_otp_calls=$'tab 0\nget count input[autocomplete="one-time-code"], input[name="code"], input[inputmode="numeric"]\ntab 0\nfill input[autocomplete="one-time-code"], input[name="code"], input[inputmode="numeric"] 424242'
if [[ "$(<"$otp_call_log")" != "$expected_otp_calls" ]]; then
  echo "browser helper must leave OTP submission to Clerk" >&2
  exit 1
fi

CONSENT_CALL_LOG="$consent_call_log" bash -c '
  source "$1"
  agent-browser() {
    printf "%s\n" "$*" >> "$CONSENT_CALL_LOG"
    if [[ "$1" == "get" && "$2" == "count" ]]; then
      printf "1\n"
    fi
  }
  BROWSER_PAGE_INDEX=0
  accept_legal_consent
' _ "$browser_helper"
expected_consent_calls=$'tab 0\nget count input[name="legalAccepted"]:not(:checked)\ntab 0\nclick input[name="legalAccepted"]:not(:checked)'
if [[ "$(<"$consent_call_log")" != "$expected_consent_calls" ]]; then
  echo "browser helper must accept Clerk native legal consent" >&2
  exit 1
fi

next_step_status=0
NEXT_STEP_CALL_LOG="$next_step_call_log" bash -c '
  source "$1"
  wait_for_browser_target() {
    printf "wait %s\n" "$*" >> "$NEXT_STEP_CALL_LOG"
    return 1
  }
  report_auth_page_failure() {
    printf "report\n" >> "$NEXT_STEP_CALL_LOG"
  }
  agent_browser_on_page() {
    printf "unexpected %s\n" "$*" >> "$NEXT_STEP_CALL_LOG"
  }
  wait_for_auth_next_step sign-in
' _ "$browser_helper" || next_step_status=$?
if [[ "$next_step_status" -ne 1 ]]; then
  echo "browser helper must propagate a failed next-step wait" >&2
  exit 1
fi
if ! grep -Fq "signIn?.status === 'needs_first_factor'" "$next_step_call_log"; then
  echo "browser helper must distinguish the initial password field from a prepared factor" >&2
  exit 1
fi
if grep -q '^unexpected ' "$next_step_call_log"; then
  echo "browser helper inspected a next step after its readiness wait failed" >&2
  exit 1
fi
if [[ "$(tail -n 1 "$next_step_call_log")" != "report" ]]; then
  echo "browser helper must report a failed next-step wait" >&2
  exit 1
fi

if [[ "$(grep -c '^[[:space:]]*delete_e2e_account_if_exists' "$browser_test")" -ne 2 ]]; then
  echo "browser E2E must clean its exact account before and after the test" >&2
  exit 1
fi

ruby -ryaml - \
  "${repo_root}/.github/workflows/turbo.yml" \
  "${repo_root}/.github/workflows/cleanup.yml" \
  "${repo_root}/.github/workflows/cleanup-stale.yml" \
  "${repo_root}/.github/workflows/cleanup-clerk-test-resources.yml" <<'RUBY'
turbo = YAML.load_file(ARGV.fetch(0))
cleanup = YAML.load_file(ARGV.fetch(1))
stale = YAML.load_file(ARGV.fetch(2))
scheduled_clerk = YAML.load_file(ARGV.fetch(3))

turbo_jobs = turbo.fetch("jobs")
browser = turbo_jobs.fetch("cli-e2e-02-browser")
browser_steps = browser.fetch("steps")
browser_run = browser_steps.find { |step| step["name"] == "Run browser E2E tests" }
browser_cleanup = browser_steps.find { |step| step["name"] == "Cleanup browser E2E account" }
raise "missing browser E2E execution" unless browser_run
raise "missing browser E2E account finalizer" unless browser_cleanup

expected_browser_email = "${{ needs.prepare.outputs.job-ref }}+clerk_test+${{ github.run_id }}-${{ github.run_attempt }}+browser@vm0-e2e.ai"
unless browser_run.dig("env", "E2E_ACCOUNT") == expected_browser_email &&
    browser_cleanup.dig("env", "E2E_ACCOUNT") == expected_browser_email
  raise "browser account must be scoped to the current run and attempt"
end
unless browser_cleanup.fetch("if") == "always()" &&
    browser_cleanup.fetch("run").include?("delete_e2e_account_if_exists")
  raise "browser account cleanup must always use the exact shared helper"
end

playwright = turbo_jobs.fetch("cli-e2e-02-playwright")
playwright_cleanup = playwright.fetch("steps").find do |step|
  step["name"] == "Cleanup Playwright E2E accounts"
end
if playwright_cleanup
  raise "Playwright matrix lanes must not reconcile their shared generation"
end

playwright_finalizer = turbo_jobs.fetch("cli-e2e-02-playwright-finalize")
unless playwright_finalizer["continue-on-error"] == true
  raise "Playwright finalization must not fail the workflow"
end
unless Array(playwright_finalizer["needs"]).include?("cli-e2e-02-playwright")
  raise "Playwright finalizer must wait for every matrix lane"
end
playwright_finalizer_condition = playwright_finalizer.fetch("if")
unless playwright_finalizer_condition.include?("always()") &&
    playwright_finalizer_condition.include?(
      "needs.cli-e2e-02-playwright.result != 'skipped'",
    )
  raise "Playwright finalizer must run after terminal matrix outcomes"
end
playwright_finalizer_steps = playwright_finalizer.fetch("steps")
playwright_steps = turbo_jobs.fetch("cli-e2e-02-playwright").fetch("steps")
playwright_cleanup = playwright_steps.find do |step|
  step["name"] == "Cleanup recorded Playwright E2E accounts"
end
unless playwright_cleanup &&
    playwright_cleanup.fetch("if") == "always() && steps.playwright-tests.outcome != 'skipped'" &&
    playwright_cleanup.fetch("run").include?("cleanup-recorded playwright,paid-onboarding")
  raise "Playwright cleanup must use the lane's recorded current-generation resources"
end
playwright_tests = playwright_steps.find { |step| step["id"] == "playwright-tests" }
unless playwright_tests.dig("env", "E2E_CLERK_RESOURCE_DIR") ==
    playwright_cleanup.dig("env", "E2E_CLERK_RESOURCE_DIR")
  raise "Playwright tests and cleanup must share their resource records"
end
if playwright_finalizer_steps.any? { |step| step.fetch("run", "").include?("cleanup-generation") }
  raise "Playwright report finalization must not scan the whole Clerk instance"
end

runner_cleanup = turbo_jobs.fetch("cli-e2e-03-runner-cleanup")
unless runner_cleanup["continue-on-error"] == true
  raise "runner E2E cleanup must not fail the workflow"
end
runner_condition = runner_cleanup.fetch("if")
unless runner_condition.include?("always()") &&
    !runner_condition.include?("!= 'cancelled'")
  raise "runner cleanup must remain eligible after cancelled preparation"
end
runner_cleanup_steps = runner_cleanup.fetch("steps")
runner_scope_step = runner_cleanup_steps.find do |step|
  step["id"] == "cleanup-scope"
end
raise "missing runner E2E cleanup scope" unless runner_scope_step
unless runner_scope_step.dig("env", "PREPARE_RESULT") ==
    "${{ needs.cli-e2e-03-runner-prepare.result }}" &&
    runner_scope_step.dig("env", "RUNNER_RESULT") ==
      "${{ needs.cli-e2e-03-runner.result }}"
  raise "runner cleanup scope must use exact upstream results"
end
runner_generation_cleanup = runner_cleanup_steps.find do |step|
  step["name"] == "Cleanup current runner E2E generation"
end
runner_run_cleanup = runner_cleanup_steps.find do |step|
  step["name"] == "Cleanup runner E2E workflow run"
end
unless runner_generation_cleanup&.fetch("run", "")&.end_with?(
    "runner-account.ts cleanup-recorded-generation",
  ) && runner_generation_cleanup["if"] ==
    "steps.cleanup-scope.outputs.scope == 'generation'"
  raise "failed preparation must reconcile only its current generation"
end
unless runner_run_cleanup&.fetch("run", "")&.end_with?(
    "runner-account.ts cleanup-recorded-run",
  ) && runner_run_cleanup["if"] ==
    "steps.cleanup-scope.outputs.scope == 'run'"
  raise "successful runner work must reconcile its exact workflow run"
end
legacy_output_environment = %w[
  E2E_RUNNER_ORGANIZATION_ID
  E2E_RUNNER_CODEX_ORGANIZATION_ID
  E2E_RUNNER_CLAUDE_ORGANIZATION_ID
]
runner_account_cleanup_steps = [runner_generation_cleanup, runner_run_cleanup]
if runner_account_cleanup_steps.any? do |step|
    legacy_output_environment.any? { |name| step.fetch("env", {}).key?(name) }
  end
  raise "runner cleanup must not depend on complete preparation outputs"
end

closed_pr_cleanup = cleanup.fetch("jobs").fetch("cleanup-clerk-test-resources")
unless closed_pr_cleanup.dig("permissions", "contents") == "read"
  raise "closed-PR Clerk cleanup must use read-only repository permissions"
end
closed_pr_checkout = closed_pr_cleanup.fetch("steps").find do |step|
  step.fetch("uses", "").start_with?("actions/checkout@")
end
raise "missing trusted checkout for closed-PR Clerk cleanup" unless closed_pr_checkout
unless closed_pr_checkout.dig("with", "ref") == "${{ github.event.repository.default_branch }}" &&
    closed_pr_checkout.dig("with", "persist-credentials") == false
  raise "closed-PR Clerk cleanup must execute credential-free default-branch code"
end
closed_pr_step = closed_pr_cleanup.fetch("steps").find do |step|
  step["name"] == "Delete Clerk test resources for closed PR"
end
raise "missing closed-PR Clerk cleanup command" unless closed_pr_step
unless closed_pr_step.fetch("run").end_with?("clerk-test-resources.ts cleanup-job-ref") &&
    closed_pr_step.dig("env", "JOB_REF") == "pr-${{ github.event.pull_request.number }}"
  raise "closed-PR cleanup must use the tested strict JOB_REF selector"
end

stale_jobs = stale.fetch("jobs")
if stale_jobs.key?("cleanup-clerk-test-resources")
  raise "general stale maintenance must not own frequent Clerk cleanup"
end
scheduled_triggers = scheduled_clerk.fetch(true)
unless scheduled_triggers.fetch("schedule") == [{ "cron" => "*/30 * * * *" }]
  raise "stale Clerk cleanup must run every 30 minutes"
end
manual_dispatch = scheduled_triggers.fetch("workflow_dispatch")
dry_run_input = manual_dispatch.fetch("inputs").fetch("dry-run")
unless dry_run_input.fetch("type") == "boolean" && dry_run_input.fetch("default") == false
  raise "manual stale Clerk cleanup must expose a disabled boolean dry-run input"
end
unless scheduled_clerk.dig("env", "DRY_RUN") == "${{ inputs.dry-run || false }}"
  raise "stale Clerk cleanup must forward the manual dry-run input"
end
scheduled_concurrency = scheduled_clerk.fetch("concurrency")
unless scheduled_concurrency.fetch("group") == "cleanup-clerk-test-resources" &&
    scheduled_concurrency.fetch("cancel-in-progress") == false
  raise "stale Clerk cleanup executions must serialize without cancellation"
end
scheduled_jobs = scheduled_clerk.fetch("jobs")
scheduled_cleanup = scheduled_jobs.fetch("cleanup-clerk-test-resources")
unless scheduled_cleanup.dig("permissions", "contents") == "read"
  raise "stale Clerk cleanup must use read-only repository permissions"
end
if scheduled_jobs.key?("cleanup-clerk-test-users") ||
    scheduled_jobs.key?("cleanup-clerk-empty-orgs")
  raise "legacy Clerk cleanup jobs must be removed"
end
stale_checkout = scheduled_cleanup.fetch("steps").find do |step|
  step.fetch("uses", "").start_with?("actions/checkout@")
end
raise "missing trusted checkout for stale Clerk cleanup" unless stale_checkout
unless stale_checkout.dig("with", "ref") == "${{ github.event.repository.default_branch }}" &&
    stale_checkout.dig("with", "persist-credentials") == false
  raise "stale Clerk cleanup must execute credential-free default-branch code"
end
stale_steps = scheduled_cleanup.fetch("steps").select do |step|
  step.fetch("run", "").include?("clerk-test-resources.ts cleanup-stale")
end
unless stale_steps.length == 1
  raise "stale Clerk cleanup must use one inventory pass"
end
stale_step = stale_steps.fetch(0)
expected_roles = "browser,playwright,paid-onboarding,runner,runner-real-codex,runner-real-claude,runner-mock-claude"
unless stale_step.fetch("run").include?(
    "cleanup-stale #{expected_roles} --ci-older-than-hours 2 --staging-browser-older-than-hours 8",
  ) && stale_step.dig("env", "CLERK_SECRET_KEY") == "${{ secrets.CLERK_SECRET_KEY }}" &&
    stale_step.dig("env", "DRY_RUN") == "${{ env.DRY_RUN }}"
  raise "stale Clerk cleanup must use every marked role, a 2-hour CI cutoff, and an 8-hour staging browser cutoff"
end

cleanup_sources = [
  File.read(ARGV.fetch(1)),
  File.read(ARGV.fetch(2)),
  File.read(ARGV.fetch(3)),
].join("\n")
if cleanup_sources.include?("api.clerk.com") ||
    cleanup_sources.include?("memberships?limit=1")
  raise "untested legacy Clerk deletion logic remains in maintenance workflows"
end
RUBY

echo "clerk-test-resource-workflow-test: ok"
