#!/usr/bin/env bats
# brw-t01-platform-e2e.bats — Hosted Clerk sign-up and sign-in with one test account
#
# These two tests exercise Clerk's hosted forms on the deployed platform via
# agent-browser:
#   1. Sign up a new test account through hosted Clerk
#   2. Sign out, then sign in with the same account
#
# Tests 3-11 (token sign-in, onboarding, chat, team, automation) are covered
# by the Playwright suite and have been removed from this file.
#
# Required env vars:
#   OKOU_API_BACKEND_URL - API URL and local fallback for the auth URL
#   CLERK_SECRET_KEY    - Backend key used to clean the exact test account
#
# Optional env vars:
#   OKOU_AUTH_URL           - Target auth URL (e.g., https://pr-123-app.omby.ai)
#   OKOU_AUTH_DOMAIN        - API domain override for auth callbacks
#   OKOU_AUTH_REDIRECT_URL  - Post-auth app URL to verify Clerk completion
#   E2E_ACCOUNT            - Test email (auto-generated if empty)

load '../../helpers/setup'
load '../../helpers/browser'

setup_file() {
  BROWSER_SESSION_PREFIX="${JOB_REF:-local}-${GITHUB_RUN_ID:-$$}-${GITHUB_RUN_ATTEMPT:-1}"
  export BROWSER_SESSION_PREFIX
  export AGENT_BROWSER_SESSION="${BROWSER_SESSION_PREFIX}-sign-up"
  browser_setup
  delete_e2e_account_if_exists

  # Generate a password for sign-up
  SIGNUP_PASSWORD="$(generate_password)"
  export SIGNUP_PASSWORD
  SIGN_UP_COMPLETE_FILE="${BATS_FILE_TMPDIR}/sign-up-complete"
  export SIGN_UP_COMPLETE_FILE

  echo "# Hosted Clerk E2E (sign-up and sign-in)" >&3
  echo "#   Auth URL: ${OKOU_AUTH_URL:-${E2E_API_BACKEND_URL}}" >&3
  echo "#   Auth domain: ${OKOU_AUTH_DOMAIN:-<default>}" >&3
  echo "#   Auth redirect URL: ${OKOU_AUTH_REDIRECT_URL:-<default>}" >&3
  echo "#   Email: $E2E_ACCOUNT" >&3
}

teardown_file() {
  local status=0
  browser_teardown || status=$?
  delete_e2e_account_if_exists || status=$?
  return "$status"
}

auth_url() {
  local path="$1"
  local base="${OKOU_AUTH_URL:-${E2E_API_BACKEND_URL}}"
  local url="${base%/}${path}"

  if [[ -n "${OKOU_AUTH_REDIRECT_URL:-}" ]]; then
    local separator="?"
    if [[ "$url" == *\?* ]]; then
      separator="&"
    fi
    url="${url}${separator}redirect_url=$(encode_uri_component "$OKOU_AUTH_REDIRECT_URL")"
  fi

  if [[ -n "${OKOU_AUTH_DOMAIN:-}" ]]; then
    local separator="?"
    if [[ "$url" == *\?* ]]; then
      separator="&"
    fi
    url="${url}${separator}domain=$(encode_uri_component "$OKOU_AUTH_DOMAIN")"
  fi

  printf '%s' "$url"
}

encode_uri_component() {
  node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$1"
}

wait_for_auth_completion() {
  local auth_path="$1"
  local completion_expression

  if [[ -n "${OKOU_AUTH_REDIRECT_URL:-}" ]]; then
    local redirect_url_json
    redirect_url_json=$(node -e \
      'process.stdout.write(JSON.stringify(process.argv[1]))' \
      "$OKOU_AUTH_REDIRECT_URL")
    completion_expression="window.location.href.startsWith(${redirect_url_json})"
  else
    completion_expression="!window.location.pathname.includes('/${auth_path}')"
  fi

  if ! wait_for_browser_target --fn "$completion_expression"; then
    report_auth_page_failure
    return 1
  fi
}

open_auth_form() {
  local url="$1"
  local target_expression="$2"
  local failed_script_expression
  failed_script_expression="performance.getEntriesByType('resource').some(
    (entry) => {
      const resourceUrl = new URL(entry.name);
      return resourceUrl.origin === location.origin
        && entry.initiatorType === 'script'
        && entry.responseStatus >= 400;
    }
  )"

  open_browser_page "$url"
  if wait_for_browser_target --timeout-seconds 30 --fn \
    "Boolean(${target_expression}) || Boolean(${failed_script_expression})"; then
    if [[ "$(agent_browser_on_page eval "Boolean(${target_expression})")" == "true" ]]; then
      return
    fi

    report_auth_page_failure
    local failed_script_urls_json
    failed_script_urls_json="$(agent_browser_on_page eval \
      "Array.from(new Set(
        performance.getEntriesByType('resource')
          .filter((entry) => {
            const resourceUrl = new URL(entry.name);
            return resourceUrl.origin === location.origin
              && entry.initiatorType === 'script'
              && entry.responseStatus >= 400;
          })
          .map((entry) => entry.name)
      ))")"
    local -a failed_script_urls
    mapfile -t failed_script_urls < <(
      jq -r '.[]' <<< "$failed_script_urls_json"
    )
    if (( ${#failed_script_urls[@]} == 0 )); then
      return 1
    fi
    local failed_script_url
    for failed_script_url in "${failed_script_urls[@]}"; do
      if ! wait_for_javascript_target \
        --timeout-seconds 60 \
        "$failed_script_url"; then
        return 1
      fi
    done

    echo "# Failed app scripts are available; reloading once" >&3
    agent_browser_on_page reload
    if ! wait_for_browser_target --timeout-seconds 30 --fn "$target_expression"; then
      report_auth_page_failure
      return 1
    fi
    echo "# Auth form recovered after app script propagation" >&3
    return
  fi

  report_auth_page_failure

  # A failed app module request leaves the static HTML bootstrap skeleton in
  # place before Clerk exists. Recover that transport failure once without
  # masking a Clerk form stall after the application has started.
  if [[ "$(agent_browser_on_page eval \
    "Boolean(
      document.getElementById('app-bootstrap-skeleton')
      && typeof window.Clerk === 'undefined'
    )")" != "true" ]]; then
    return 1
  fi

  echo "# App bootstrap did not complete; reloading once" >&3
  agent_browser_on_page reload
  if ! wait_for_browser_target --timeout-seconds 30 --fn "$target_expression"; then
    report_auth_page_failure
    return 1
  fi
  echo "# App bootstrap recovered after reload" >&3
}

# ===========================================================================
# Phase 1: Sign up
# ===========================================================================

@test "sign up a new test account" {
  local sign_up_url
  sign_up_url="$(auth_url "/sign-up")"
  echo "# Navigating to $sign_up_url" >&3
  open_auth_form "$sign_up_url" \
    "Boolean(
      document.querySelector('input[name=\"emailAddress\"]')
      && document.querySelector('input[type=\"password\"]')
    )"
  dismiss_cookie_banner

  # Fill sign-up form
  echo "# Filling sign-up form with $E2E_ACCOUNT" >&3
  agent_browser_on_page find label "Email address" fill "$E2E_ACCOUNT" --exact
  agent_browser_on_page find label "Password" fill "$SIGNUP_PASSWORD" --exact
  accept_legal_consent
  click_continue

  local sign_up_state
  sign_up_state="$(wait_for_auth_next_step "sign-up")"
  if [[ "$sign_up_state" == "otp" ]]; then
    enter_otp "$OTP"
    wait_for_auth_completion "sign-up"
  fi
  touch "$SIGN_UP_COMPLETE_FILE"
  echo "# Sign-up successful!" >&3
}

# ===========================================================================
# Phase 2: Sign out and sign in
# ===========================================================================

@test "sign out and sign in with same account" {
  if [[ ! -f "$SIGN_UP_COMPLETE_FILE" ]]; then
    echo "# Sign-in prerequisite failed: sign-up did not complete" >&3
    return 1
  fi

  # Start a fresh isolated session so auth state cannot leak across cases.
  agent-browser close 2>/dev/null || true
  export AGENT_BROWSER_SESSION="${BROWSER_SESSION_PREFIX}-sign-in"
  browser_setup

  # Re-open sign-in page
  local sign_in_url
  sign_in_url="$(auth_url "/sign-in")"
  echo "# Navigating to $sign_in_url" >&3
  open_auth_form "$sign_in_url" \
    "!window.location.pathname.includes('/sign-in')
      || Boolean(document.querySelector('input[name=\"identifier\"]'))"

  # Check if already signed in (redirected away from /sign-in)
  local current_url
  current_url=$(agent_browser_on_page get url 2>/dev/null || true)
  if [[ -n "$current_url" && ! "$current_url" =~ sign-in ]]; then
    echo "# Already signed in (redirected to $current_url)" >&3
    return 0
  fi

  dismiss_cookie_banner

  # Enter email and click Continue
  echo "# Entering email: $E2E_ACCOUNT" >&3
  agent_browser_on_page find label "Email address" fill "$E2E_ACCOUNT" --exact
  click_continue

  local sign_in_state
  sign_in_state="$(wait_for_auth_next_step "sign-in")"
  if [[ "$sign_in_state" == "complete" ]]; then
    echo "# Sign-in completed after email submit" >&3
    return 0
  fi

  if [[ "$sign_in_state" == "password" ]]; then
    # Clerk renders the forgot-password action before the alternate methods
    # finish mounting. Wait for the control this test actually consumes so a
    # partial password form cannot send the flow down a transient branch.
    wait_for_browser_target --text "Use another method"
    agent_browser_on_page find text "Use another method" click
    wait_for_browser_target --text "Email code"
    agent_browser_on_page find text "Email code" click
  fi

  wait_for_sign_in_email_code_ready
  enter_otp "$OTP"
  wait_for_auth_completion "sign-in"
  echo "# Sign-in successful!" >&3
}
