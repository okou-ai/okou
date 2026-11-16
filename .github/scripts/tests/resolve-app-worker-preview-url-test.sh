#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
script="${repo_root}/.github/scripts/resolve-app-worker-preview-url.sh"

test "$(bash "$script" pr-22085 vm0)" = \
  "https://pr-22085-app-okou-app-preview.vm0.workers.dev"
test "$(bash "$script" staging vm0-preview)" = \
  "https://staging-app-okou-app-preview.vm0-preview.workers.dev"

if bash "$script" pr-22085 '' >/dev/null 2>&1; then
  echo "expected a missing Cloudflare Workers subdomain to be rejected" >&2
  exit 1
fi

if bash "$script" production vm0 >/dev/null 2>&1; then
  echo "expected an unsupported job ref to be rejected" >&2
  exit 1
fi

if bash "$script" '' vm0 >/dev/null 2>&1; then
  echo "expected a missing job ref to be rejected" >&2
  exit 1
fi

if bash "$script" pr-22085 'evil.example' >/dev/null 2>&1; then
  echo "expected an invalid Cloudflare Workers subdomain to be rejected" >&2
  exit 1
fi

echo "resolve-app-worker-preview-url tests passed"
