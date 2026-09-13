#!/usr/bin/env bash
# browser.bash — Reusable bats helpers for agent-browser E2E tests
#
# Provides helper functions for browser automation via agent-browser.
# Load from bats tests with: load '../../helpers/browser'
#
# Required env vars:
#   OKOU_API_BACKEND_URL — Target API backend URL (e.g., https://api.vm7.ai:8443)
#
# Optional env vars:
#   E2E_ACCOUNT  — Test email address (auto-generated if empty)
#   VERCEL_AUTOMATION_BYPASS_SECRET — Seed preview bypass cookies

# ---------------------------------------------------------------------------
# url_is_on_app — Check if a URL's hostname matches the expected app hostname
# Usage: url_is_on_app <url> [check_url]
#   check_url — URL to compare against (default: APP_URL from calling context)
# Compares hostnames rather than assuming "app." prefix, so it works for all
# environments (app.vm7.ai, staging-app.omby.ai, etc.).
# ---------------------------------------------------------------------------
url_is_on_app() {
  local url="$1"
  local check_url="${2:-$APP_URL}"
  local url_host check_host
  url_host=$(echo "$url" | sed -n 's|.*://\([^/:]*\).*|\1|p')
  check_host=$(echo "$check_url" | sed -n 's|.*://\([^/:]*\).*|\1|p')
  [[ "$url_host" == "$check_host" ]]
}

# ---------------------------------------------------------------------------
# capture_browser_page / focus_browser_page / agent_browser_on_page
# Keep every page operation bound to the tab that browser_setup launched.
# agent-browser 0.22 automatically activates event-discovered targets, so an
# auxiliary about:blank target must not take ownership from the E2E page.
# ---------------------------------------------------------------------------
capture_browser_page() {
  local tabs_json
  tabs_json="$(agent-browser --json tab)" || return

  BROWSER_PAGE_INDEX="$(
    jq -e -r '.data.tabs[] | select(.active == true) | .index' \
      <<<"$tabs_json"
  )" || return
  if [[ ! "$BROWSER_PAGE_INDEX" =~ ^[0-9]+$ ]]; then
    echo "Failed to capture the active browser page" >&2
    return 1
  fi
  export BROWSER_PAGE_INDEX
}

focus_browser_page() {
  if [[ ! "${BROWSER_PAGE_INDEX:-}" =~ ^[0-9]+$ ]]; then
    echo "Browser page ownership is not initialized" >&2
    return 1
  fi

  local target_index="$BROWSER_PAGE_INDEX"
  if [[ -n "${BROWSER_PAGE_URL:-}" ]]; then
    local tabs_json
    tabs_json="$(agent-browser --json tab)" || return

    local -a matching_indexes=()
    local index candidate_url
    local tab_records
    tab_records="$(jq -r '.data.tabs[] | [.index, .url] | @tsv' <<<"$tabs_json")" || return
    while IFS=$'\t' read -r index candidate_url; do
      if browser_page_url_matches "$candidate_url" "$BROWSER_PAGE_URL"; then
        matching_indexes+=("$index")
      fi
    done <<<"$tab_records"

    if (( ${#matching_indexes[@]} != 1 )); then
      echo "Expected one owned browser page, found ${#matching_indexes[@]}" >&2
      return 1
    fi
    target_index="${matching_indexes[0]}"
    BROWSER_PAGE_INDEX="$target_index"
    export BROWSER_PAGE_INDEX
  fi

  agent-browser tab "$target_index" >/dev/null
}

browser_page_url_matches() {
  local candidate_url="$1"
  local expected_url="$2"
  if [[ "$expected_url" == http://* || "$expected_url" == https://* ]]; then
    url_is_on_app "$candidate_url" "$expected_url"
  else
    [[ "$candidate_url" == "$expected_url" ]]
  fi
}

agent_browser_on_page() {
  focus_browser_page || return
  agent-browser "$@"
}

open_browser_page() {
  local url="$1"
  focus_browser_page || return
  agent-browser open "$url" || return
  BROWSER_PAGE_URL="$url"
  export BROWSER_PAGE_URL
}

# ---------------------------------------------------------------------------
# resolve_e2e_api_backend_url — Resolve the canonical E2E API URL contract
# The resolved value is preserved byte-for-byte and never logged.
# ---------------------------------------------------------------------------
resolve_e2e_api_backend_url() {
  if [[ -z "${OKOU_API_BACKEND_URL:-}" ]]; then
    echo "E2E API backend URL is required: canonical_key=OKOU_API_BACKEND_URL state=missing" >&2
    return 1
  fi
  E2E_API_BACKEND_URL="$OKOU_API_BACKEND_URL"
  export E2E_API_BACKEND_URL
}

# ---------------------------------------------------------------------------
# browser_setup — Validate environment, initialize shared state
# Call this in setup_file() before any browser interactions.
# ---------------------------------------------------------------------------
browser_setup() {
  resolve_e2e_api_backend_url || return

  if ! command -v agent-browser &>/dev/null; then
    echo "agent-browser is not installed. Install with: npm install -g agent-browser" >&2
    return 1
  fi

  export NODE_TLS_REJECT_UNAUTHORIZED=0
  export AGENT_BROWSER_SESSION="${AGENT_BROWSER_SESSION:-${JOB_REF:-local}-sign-up}"
  unset BROWSER_PAGE_URL

  export OTP="424242"

  if [[ -z "${E2E_ACCOUNT:-}" ]]; then
    E2E_ACCOUNT="$(generate_test_email)"
    export E2E_ACCOUNT
  fi

  AGENT_BROWSER_IGNORE_HTTPS_ERRORS=true \
    agent-browser set viewport 1920 1080 || return

  capture_browser_page || return
  seed_preview_bypass_cookies || return
}

# ---------------------------------------------------------------------------
# seed_preview_bypass_cookies — Seed Vercel bypass on API and app hosts
# Setting both cookies directly avoids booting Clerk on an intermediate app
# navigation before the auth page opens.
# ---------------------------------------------------------------------------
seed_preview_bypass_cookies() {
  if [[ -z "${VERCEL_AUTOMATION_BYPASS_SECRET:-}" ]]; then
    return
  fi

  local base_url
  for base_url in "$E2E_API_BACKEND_URL" "${OKOU_AUTH_URL:-}"; do
    if [[ -z "$base_url" ]]; then
      continue
    fi

    local cookie_args=(
      --url "${base_url%/}/"
      --sameSite Lax
    )
    if [[ "$base_url" == https://* ]]; then
      cookie_args+=(--secure)
    fi

    if ! agent-browser cookies set \
      "x-vercel-protection-bypass" \
      "$VERCEL_AUTOMATION_BYPASS_SECRET" \
      "${cookie_args[@]}" >/dev/null 2>&1; then
      echo "Failed to seed preview automation bypass" >&2
      return 1
    fi
  done
}

# ---------------------------------------------------------------------------
# report_auth_page_failure — Emit fast, redacted failure diagnostics
# Keeps normal runs quiet and avoids screenshots/snapshots.
# ---------------------------------------------------------------------------
report_auth_page_failure() {
  focus_browser_page >/dev/null 2>&1 || true

  echo "# Auth page state:" >&3
  agent-browser eval \
    '({
      url: location.origin + location.pathname,
      readyState: document.readyState,
      text: (document.body?.innerText ?? "").slice(0, 500),
      bootstrapSkeleton: Boolean(
        document.getElementById("app-bootstrap-skeleton")
      ),
      clerkDefined: typeof window.Clerk !== "undefined",
      clerkLoaded: window.Clerk?.loaded ?? null,
      serviceWorkerController: Boolean(navigator.serviceWorker?.controller),
      navigation: performance.getEntriesByType("navigation").map((entry) => ({
        status: entry.responseStatus ?? null,
        duration: Math.round(entry.duration),
        domInteractive: Math.round(entry.domInteractive),
        loadEventEnd: Math.round(entry.loadEventEnd),
      })),
      resources: performance.getEntriesByType("resource")
        .map((entry) => {
          const url = new URL(entry.name);
          return {
            host: url.host,
            path: url.pathname,
            type: entry.initiatorType,
            status: entry.responseStatus ?? null,
            duration: Math.round(entry.duration),
          };
        })
        .filter((entry) =>
          entry.status >= 400
          || entry.duration >= 5000
          || entry.host.includes("clerk")
          || entry.host.includes("accounts")
        )
        .slice(-50),
      scripts: Array.from(document.scripts)
        .map((script) => script.src)
        .filter(Boolean)
        .map((src) => {
          const url = new URL(src);
          return { host: url.host, path: url.pathname };
        }),
    })' >&3 2>&1 || true

  echo "# Browser errors:" >&3
  agent-browser errors 2>&1 \
    | sed -E 's/(x-vercel-protection-bypass=)[^&[:space:]]+/\1[REDACTED]/g' \
    | tail -80 >&3 || true

  echo "# Failed network requests:" >&3
  agent-browser network requests --status 400-599 2>&1 \
    | sed -E 's/(x-vercel-protection-bypass=)[^&[:space:]]+/\1[REDACTED]/g' \
    | tail -80 >&3 || true

  echo "# Browser console:" >&3
  agent-browser console 2>&1 \
    | sed -E 's/(x-vercel-protection-bypass=)[^&[:space:]]+/\1[REDACTED]/g' \
    | tail -80 >&3 || true
}

# ---------------------------------------------------------------------------
# generate_test_email — Generate the generation-scoped browser test email
# Format: ${JOB_REF}+clerk_test+${RUN_ID}-${ATTEMPT}+browser@vm0-e2e.ai
# ---------------------------------------------------------------------------
generate_test_email() {
  local job_ref="${JOB_REF:-local}"
  if [[ ! "$job_ref" =~ ^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$ ]]; then
    echo "JOB_REF must use lowercase letters, numbers, and hyphens" >&2
    return 1
  fi
  local generation="local-1"
  if [[ -n "${GITHUB_RUN_ID:-}" || -n "${GITHUB_RUN_ATTEMPT:-}" ]]; then
    if [[ ! "${GITHUB_RUN_ID:-}" =~ ^[1-9][0-9]*$ ]] ||
      [[ ! "${GITHUB_RUN_ATTEMPT:-}" =~ ^[1-9][0-9]*$ ]]; then
      echo "GITHUB_RUN_ID and GITHUB_RUN_ATTEMPT must both be positive integers" >&2
      return 1
    fi
    generation="${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
  fi
  echo "${job_ref}+clerk_test+${generation}+browser@vm0-e2e.ai"
}

# ---------------------------------------------------------------------------
# wait_for_browser_target — Wait for a browser target across navigation
# Poll the target so no individual agent-browser command reaches its
# 30-second IPC read timeout. Supports the wait forms used by browser E2E:
# selectors, --fn expressions, and --text values.
# Usage: wait_for_browser_target [--timeout-seconds <seconds>]
#          <selector>|--fn <expression>|--text <text>
# ---------------------------------------------------------------------------
wait_for_browser_target() {
  local wait_timeout_seconds=60
  if [[ "${1:-}" == "--timeout-seconds" ]]; then
    wait_timeout_seconds="${2:?wait timeout is required}"
    shift 2
  fi

  local condition description value_json
  case "${1:-}" in
    --fn)
      condition="Boolean(${2:?wait expression is required})"
      description="JavaScript condition"
      ;;
    --text)
      value_json=$(node -e \
        'process.stdout.write(JSON.stringify(process.argv[1]))' \
        "${2:?wait text is required}")
      condition="(document.body?.innerText ?? '').toLowerCase().includes(${value_json}.toLowerCase())"
      description="text ${2}"
      ;;
    *)
      value_json=$(node -e \
        'process.stdout.write(JSON.stringify(process.argv[1]))' \
        "${1:?wait selector is required}")
      condition="Boolean(document.querySelector(${value_json}))"
      description="selector ${1}"
      ;;
  esac

  local wait_started="$SECONDS"
  local wait_output
  while (( SECONDS - wait_started < wait_timeout_seconds )); do
    if wait_output=$(agent_browser_on_page eval "$condition" 2>&1); then
      if [[ "$wait_output" == "true" ]]; then
        return 0
      fi
    elif [[ "$wait_output" != *"Inspected target navigated or closed"* ]]; then
      echo "$wait_output" >&2
      return 1
    fi
    sleep 0.25
  done

  echo "Wait timed out after $((wait_timeout_seconds * 1000))ms: ${description}" >&2
  return 1
}

# ---------------------------------------------------------------------------
# wait_for_javascript_target — Poll a fixed URL from the current browser until
# it returns JavaScript. A successful fetch also warms the page's service
# worker cache before the caller reloads.
# Usage: wait_for_javascript_target [--timeout-seconds <seconds>] <url>
# ---------------------------------------------------------------------------
wait_for_javascript_target() {
  local wait_timeout_seconds=60
  if [[ "${1:-}" == "--timeout-seconds" ]]; then
    wait_timeout_seconds="${2:?wait timeout is required}"
    shift 2
  fi

  local url="${1:?wait URL is required}"
  local url_json
  url_json=$(node -e \
    'process.stdout.write(JSON.stringify(process.argv[1]))' \
    "$url")
  local wait_started="$SECONDS"
  while (( SECONDS - wait_started < wait_timeout_seconds )); do
    local target_ready
    target_ready="$(agent_browser_on_page eval \
      "(async () => {
        try {
          const response = await fetch(${url_json}, { cache: 'reload' });
          const contentType = response.headers.get('content-type') ?? '';
          return response.ok && contentType.includes('javascript');
        } catch {
          return false;
        }
      })()" 2>/dev/null || true)"
    if [[ "$target_ready" == "true" ]]; then
      return 0
    fi
    sleep 0.5
  done

  echo "Wait timed out after $((wait_timeout_seconds * 1000))ms: JavaScript URL ${url}" >&2
  return 1
}

# ---------------------------------------------------------------------------
# wait_for_auth_next_step — Wait for Clerk to redirect or render its next form
# Emits one of: complete, otp, password.
# ---------------------------------------------------------------------------
wait_for_auth_next_step() {
  local auth_path="$1"
  local otp_selector='input[autocomplete="one-time-code"], input[name="code"], input[inputmode="numeric"]'

  if ! wait_for_browser_target --fn \
    "(() => {
      if (!window.location.pathname.includes('/${auth_path}')) return true;
      if (document.querySelector('${otp_selector}')) return true;
      if ('${auth_path}' !== 'sign-in') return false;
      const signIn = window.Clerk?.client?.signIn;
      const text = (document.body?.innerText ?? '').toLowerCase();
      return signIn?.status === 'needs_first_factor'
        && (Boolean(document.querySelector('input[type=\"password\"]'))
          || text.includes('use another method')
          || text.includes('forgot password'));
    })()"; then
    report_auth_page_failure
    return 1
  fi

  if [[ "$(agent_browser_on_page eval "window.location.pathname.includes('/${auth_path}')")" != "true" ]]; then
    echo "complete"
  elif [[ "$(agent_browser_on_page get count "$otp_selector")" -gt 0 ]]; then
    echo "otp"
  else
    echo "password"
  fi
}

# ---------------------------------------------------------------------------
# wait_for_sign_in_email_code_ready — Wait for Clerk to finish preparing the
# email-code first factor before entering the code. The OTP input mounts while
# prepareFirstFactor is still in flight, so its presence is not a readiness
# signal for attemptFirstFactor.
# ---------------------------------------------------------------------------
wait_for_sign_in_email_code_ready() {
  wait_for_browser_target --fn \
    "(() => {
      const verification =
        window.Clerk?.client?.signIn?.firstFactorVerification;
      return verification?.strategy === 'email_code'
        && verification.status === 'unverified';
    })()"
}

# ---------------------------------------------------------------------------
# accept_legal_consent — Accept legal consent when the auth form requires it
# ---------------------------------------------------------------------------
accept_legal_consent() {
  local legal_consent_selector='input[name="legalAccepted"]:not(:checked)'
  if [[ "$(agent_browser_on_page get count "$legal_consent_selector")" -gt 0 ]]; then
    agent_browser_on_page click "$legal_consent_selector"
  fi
}

# ---------------------------------------------------------------------------
# click_continue — Click form "Continue" button (not "Continue with Google")
# ---------------------------------------------------------------------------
click_continue() {
  if ! wait_for_browser_target --fn \
    "Array.from(document.querySelectorAll('button')).some(
      (button) => button.textContent?.trim() === 'Continue' && !button.disabled
    )"; then
    return 1
  fi
  agent_browser_on_page eval \
    "Array.from(document.querySelectorAll('button'))
      .find((button) => button.textContent?.trim() === 'Continue' && !button.disabled)
      ?.scrollIntoView({ block: 'center' })" >/dev/null || return
  agent_browser_on_page find role button click --name "Continue" --exact
}

# ---------------------------------------------------------------------------
# dismiss_cookie_banner — Dismiss cookie consent banner if present
# ---------------------------------------------------------------------------
dismiss_cookie_banner() {
  if [[ "$(agent_browser_on_page eval \
    "Array.from(document.querySelectorAll('button')).some(
      (button) => button.textContent?.trim() === 'Accept'
    )")" == "true" ]]; then
    agent_browser_on_page find role button click --name "Accept" --exact
  fi
}

# ---------------------------------------------------------------------------
# enter_otp — Enter OTP verification code
# ---------------------------------------------------------------------------
enter_otp() {
  local code="$1"
  local otp_selector='input[autocomplete="one-time-code"], input[name="code"], input[inputmode="numeric"]'

  if ! wait_for_browser_target "$otp_selector"; then
    return 1
  fi
  if [[ "$(agent_browser_on_page get count "$otp_selector")" -eq 1 ]]; then
    agent_browser_on_page fill "$otp_selector" "$code"
  else
    agent_browser_on_page find first "$otp_selector" click
    local digit
    for digit in $(echo "$code" | grep -o .); do
      agent_browser_on_page press "$digit"
    done
  fi
}

# ---------------------------------------------------------------------------
# generate_password — Generate random 20-char password for sign-up
# ---------------------------------------------------------------------------
generate_password() {
  local rand
  rand=$(head -c 32 /dev/urandom | base64 | tr -d '/+=\n')
  echo "${rand:0:16}!Aa1"
}

# ---------------------------------------------------------------------------
# create_clerk_sign_in_token — Create a Clerk sign-in token for e2e test user
# Requires CLERK_SECRET_KEY. Exports SIGN_IN_TOKEN on success.
# ---------------------------------------------------------------------------
create_clerk_sign_in_token() {
  if [[ -z "${CLERK_SECRET_KEY:-}" ]]; then
    echo "CLERK_SECRET_KEY is required but not set" >&2
    return 1
  fi

  local email="${E2E_ACCOUNT}"

  local clerk_api_url="https://api.clerk.com"

  # Resolve user ID from email
  local users_response
  users_response=$(curl -sS -X GET \
    "${clerk_api_url}/v1/users?email_address[]=${email}" \
    -H "Authorization: Bearer ${CLERK_SECRET_KEY}" \
    -H "Content-Type: application/json")

  local user_id
  user_id=$(echo "$users_response" | jq -e -r '.[0].id' 2>/dev/null)
  if [[ -z "$user_id" || "$user_id" == "null" ]]; then
    echo "Failed to resolve user ID for ${email}" >&2
    echo "API response: ${users_response}" >&2
    return 1
  fi

  # Create sign-in token
  local token_response
  token_response=$(curl -sS -X POST \
    "${clerk_api_url}/v1/sign_in_tokens" \
    -H "Authorization: Bearer ${CLERK_SECRET_KEY}" \
    -H "Content-Type: application/json" \
    -d "{\"user_id\": \"${user_id}\", \"expires_in_seconds\": 300}")

  local token
  token=$(echo "$token_response" | jq -e -r '.token' 2>/dev/null)
  if [[ -z "$token" || "$token" == "null" ]]; then
    echo "Failed to create sign-in token" >&2
    echo "API response: ${token_response}" >&2
    return 1
  fi

  export SIGN_IN_TOKEN="$token"
}

# ---------------------------------------------------------------------------
# delete_e2e_account_if_exists — Delete the E2E_ACCOUNT from Clerk if it exists
# Call this before sign-up to ensure a clean test state.
# Requires CLERK_SECRET_KEY and E2E_ACCOUNT to be set.
# ---------------------------------------------------------------------------
delete_e2e_account_if_exists() {
  if [[ -z "${CLERK_SECRET_KEY:-}" ]]; then
    echo "CLERK_SECRET_KEY is required but not set" >&2
    return 1
  fi
  if [[ ! "${E2E_ACCOUNT:-}" =~ ^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?\+clerk_test\+([1-9][0-9]*-[1-9][0-9]*|local-1)\+browser@vm0-e2e\.ai$ ]]; then
    echo "E2E_ACCOUNT is not a canonical browser test email" >&2
    return 1
  fi

  local clerk_api_url="https://api.clerk.com"

  local users_payload
  users_payload=$(curl -sS \
    -w '\n%{http_code}' \
    --get "${clerk_api_url}/v1/users" \
    --data-urlencode "email_address[]=${E2E_ACCOUNT}" \
    -H "Authorization: Bearer ${CLERK_SECRET_KEY}" \
    -H "Content-Type: application/json") || return

  local lookup_status="${users_payload##*$'\n'}"
  local users_response="${users_payload%$'\n'*}"
  if [[ ! "$lookup_status" =~ ^2[0-9][0-9]$ ]]; then
    echo "Clerk user lookup failed with HTTP ${lookup_status}" >&2
    return 1
  fi

  if ! jq -e 'type == "array"' <<<"$users_response" >/dev/null; then
    echo "Clerk returned an unexpected user lookup response" >&2
    return 1
  fi

  local user_ids
  user_ids=$(jq -r --arg email "$E2E_ACCOUNT" \
    '.[] | select(any(.email_addresses[]?; .email_address == $email)) | .id' \
    <<<"$users_response")
  if [[ -z "$user_ids" ]]; then
    echo "E2E account does not exist, nothing to delete" >&2
    return 0
  fi

  local user_id
  while read -r user_id; do
    echo "Deleting E2E account: ${E2E_ACCOUNT} (${user_id})" >&2
    local delete_status
    if ! delete_status=$(curl -sS \
      -o /dev/null \
      -w '%{http_code}' \
      -X DELETE \
      "${clerk_api_url}/v1/users/${user_id}" \
      -H "Authorization: Bearer ${CLERK_SECRET_KEY}" \
      -H "Content-Type: application/json"); then
      return 1
    fi
    if [[ ! "$delete_status" =~ ^2[0-9][0-9]$ && "$delete_status" != "404" ]]; then
      echo "Clerk user deletion failed with HTTP ${delete_status}" >&2
      return 1
    fi
  done <<<"$user_ids"
}

# ---------------------------------------------------------------------------
# derive_app_url — Derive platform app URL from E2E_API_BACKEND_URL
# Local:  https://api.vm7.ai:8443  → https://app.vm7.ai:8443
# CI:     https://pr-123-api.vm0-dev.com → https://pr-123-app.vm0-dev.com
# ---------------------------------------------------------------------------
derive_app_url() {
  if [[ -n "${APP_URL:-}" ]]; then
    printf '%s' "$APP_URL"
    return
  fi

  local source="${E2E_API_BACKEND_URL}"
  source="${source/\/\/api./\/\/app.}"
  source="${source/-api./-app.}"
  source="${source/\/\/www./\/\/app.}"
  source="${source/-www./-app.}"
  printf '%s' "$source"
}

# ---------------------------------------------------------------------------
# sign_in_via_token — Sign in via Clerk token and wait for redirect
# Requires SIGN_IN_TOKEN to be set (call create_clerk_sign_in_token first).
# Usage: sign_in_via_token [base_url]
#   base_url — URL to sign in on (default: APP_URL, fallback: derived app URL)
# ---------------------------------------------------------------------------
sign_in_via_token() {
  local base_url="${1:-$(derive_app_url)}"
  open_browser_page "${base_url}/sign-in-token?token=${SIGN_IN_TOKEN}"

  wait_for_browser_target --fn \
    "!window.location.pathname.includes('/sign-in-token')"

  local current_url
  current_url=$(agent_browser_on_page get url 2>/dev/null || true)
  if ! url_is_on_app "$current_url" "$base_url"; then
    echo "Failed to redirect after sign-in-token" >&2
    return 1
  fi

  # Dismiss cookie banner if present
  dismiss_cookie_banner
}

# ---------------------------------------------------------------------------
# sign_in_via_token_on_app — Sign in via Clerk token on the platform app domain
# Opens /sign-in-token, waits for auth redirect, dismisses cookie banner.
# Requires APP_URL and SIGN_IN_TOKEN to be set.
# ---------------------------------------------------------------------------
sign_in_via_token_on_app() {
  echo "# Signing in via token on platform app..." >&3
  sign_in_via_token "$APP_URL"
  echo "# Authentication complete!" >&3
}

# ---------------------------------------------------------------------------
# navigate_to_app_page — Navigate to a path on the platform app domain
# Usage: navigate_to_app_page "/team"
# ---------------------------------------------------------------------------
navigate_to_app_page() {
  local path="$1"
  local app_url
  app_url="$(derive_app_url)"
  open_browser_page "${app_url}${path}"
}

# ---------------------------------------------------------------------------
# wait_for_text — Wait for text to appear on page (case-insensitive)
# Usage: wait_for_text "some text"
# ---------------------------------------------------------------------------
wait_for_text() {
  local text="$1"
  wait_for_browser_target --text "$text"
}

# ---------------------------------------------------------------------------
# wait_for_text_gone — Wait for text to disappear from page (case-insensitive)
# Usage: wait_for_text_gone "some text"
# ---------------------------------------------------------------------------
wait_for_text_gone() {
  local text="$1"
  local text_json
  text_json=$(node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$text")
  wait_for_browser_target --fn \
    "!document.body.innerText.toLowerCase().includes(${text_json}.toLowerCase())"
}

# ---------------------------------------------------------------------------
# browser_teardown — Kill agent-browser and any spawned browser processes
# Call this in teardown_file() to prevent bats from hanging.
# ---------------------------------------------------------------------------
browser_teardown() {
  # Close browser gracefully first
  agent-browser close 2>/dev/null || true

  # Kill any remaining agent-browser or chromium processes
  pkill -f 'agent-browser' 2>/dev/null || true
  pkill -f '[c]hrom(e|ium)' 2>/dev/null || true
}
