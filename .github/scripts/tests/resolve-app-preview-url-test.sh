#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
script="${repo_root}/.github/scripts/resolve-app-preview-url.sh"

test "$(bash "$script" pr-47172 omby.ai)" = \
  "https://pr-47172-app.omby.ai"
test "$(bash "$script" staging omby.ai)" = \
  "https://staging-app.omby.ai"

for job_ref in '' production pr-0 pr-1-app 'pr-1/../../'; do
  if bash "$script" "$job_ref" omby.ai >/dev/null 2>&1; then
    echo "expected an unsupported job ref to be rejected: $job_ref" >&2
    exit 1
  fi
done

for domain in '' vm0 workers.dev omby.ai.evil.example 'omby.ai:443'; do
  if bash "$script" pr-47172 "$domain" >/dev/null 2>&1; then
    echo "expected an unsupported public preview domain to be rejected: $domain" >&2
    exit 1
  fi
done

echo "resolve-app-preview-url tests passed"
