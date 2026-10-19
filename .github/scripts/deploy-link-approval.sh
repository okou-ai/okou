#!/usr/bin/env bash
set -euo pipefail

if (($# < 1 || $# > 2)) || [[ "$1" != test && "$1" != production ]]; then
  echo "Usage: $0 <test|production> [enable-approval:true|false]" >&2
  exit 2
fi
approval_environment=$1
approval_enabled=${2:-false}
if [[ "$approval_enabled" != true && "$approval_enabled" != false ]]; then
  echo "Approval startup must be explicitly true or false" >&2
  exit 2
fi
: "${CLOUDFLARE_API_TOKEN:?Cloudflare Worker deployment token is required}"
: "${CLOUDFLARE_ACCOUNT_ID:?Cloudflare account ID is required}"

node --input-type=module <<'JS'
const names = ["LINK_APPROVAL_WORKER_SECRET", "LINK_APPROVAL_CONTROL_SECRET"];
for (const name of names) {
  const value = process.env[name];
  if (!value || value.length < 32 || /\s/.test(value)) {
    throw new Error(`${name} must have at least 32 characters without whitespace`);
  }
}
if (process.env[names[0]] === process.env[names[1]]) {
  throw new Error("HMAC and control credentials must be distinct");
}
const configured = process.env.LINK_APPROVAL_API_ORIGIN;
let origin;
try { origin = new URL(configured); } catch {
  throw new Error("Invalid LINK_APPROVAL_API_ORIGIN");
}
if (origin.protocol !== "https:" || origin.origin !== configured) {
  throw new Error("LINK_APPROVAL_API_ORIGIN must be an HTTPS origin without a path or credentials");
}
JS

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
umask 077
approval_secrets="$(mktemp)"
trap 'rm -f "$approval_secrets"' EXIT
jq -n '{
  LINK_APPROVAL_WORKER_SECRET: env.LINK_APPROVAL_WORKER_SECRET,
  LINK_APPROVAL_CONTROL_SECRET: env.LINK_APPROVAL_CONTROL_SECRET,
  LINK_APPROVAL_API_ORIGIN: env.LINK_APPROVAL_API_ORIGIN
}' > "$approval_secrets"
unset LINK_APPROVAL_WORKER_SECRET LINK_APPROVAL_CONTROL_SECRET LINK_APPROVAL_API_ORIGIN

cd "$repo_root/turbo"
pnpm --filter @okouai/link-approval-worker exec wrangler deploy \
  --env "$approval_environment" \
  --var "LINK_APPROVAL_ENABLED:$approval_enabled" \
  --secrets-file "$approval_secrets" \
  --message "Link approval Workflow ${GITHUB_SHA:-manual} (enabled=$approval_enabled)"
