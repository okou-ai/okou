#!/usr/bin/env bash
set -euo pipefail

if (($# < 1 || $# > 2)) || [[ "$1" != test && "$1" != production ]]; then
  echo "Usage: $0 <test|production> [enable-gateway:true|false]" >&2
  exit 2
fi
gateway_environment=$1
gateway_enabled=${2:-false}
if [[ "$gateway_enabled" != true && "$gateway_enabled" != false ]]; then
  echo "Gateway startup must be explicitly true or false" >&2
  exit 2
fi

: "${CLOUDFLARE_API_TOKEN:?Cloudflare Worker deployment token is required}"
: "${CLOUDFLARE_ACCOUNT_ID:?Cloudflare account ID is required}"
: "${WECHAT_GATEWAY_SECRET:?Gateway HMAC secret is required}"
: "${WECHAT_GATEWAY_CONTROL_SECRET:?Gateway control secret is required}"
: "${WECHAT_API_ORIGIN:?Canonical API origin is required}"
: "${WECHAT_RECEIVER_ENCRYPTION_KEY:?Receiver encryption key is required}"

# Validate operator configuration before passing any secret to Cloudflare.
# Do not print credential values or provider responses.
node --input-type=module <<'JS'
const required = [
  "WECHAT_GATEWAY_SECRET",
  "WECHAT_GATEWAY_CONTROL_SECRET",
  "WECHAT_API_ORIGIN",
  "WECHAT_RECEIVER_ENCRYPTION_KEY",
];
const key = process.env.WECHAT_RECEIVER_ENCRYPTION_KEY;
if (!key || key.length < 32 || [process.env.WECHAT_GATEWAY_SECRET, process.env.WECHAT_GATEWAY_CONTROL_SECRET].includes(key)) {
  throw new Error("Workflows requires a distinct receiver encryption key of at least 32 characters");
}
for (const key of required) {
  const value = process.env[key];
  if (!value || /\s/.test(value)) {
    throw new Error(`Invalid ${key}`);
  }
}
for (const key of ["WECHAT_GATEWAY_SECRET", "WECHAT_GATEWAY_CONTROL_SECRET"]) {
  if (process.env[key].length < 32) {
    throw new Error(`${key} must have at least 32 characters`);
  }
}
if (new Set([
  process.env.WECHAT_GATEWAY_SECRET,
  process.env.WECHAT_GATEWAY_CONTROL_SECRET,
]).size !== 2) {
  throw new Error("HMAC and control credentials must be distinct");
}
let origin;
try {
  origin = new URL(process.env.WECHAT_API_ORIGIN);
} catch {
  throw new Error("Invalid WECHAT_API_ORIGIN");
}
if (origin.protocol !== "https:" || origin.origin !== process.env.WECHAT_API_ORIGIN) {
  throw new Error("WECHAT_API_ORIGIN must be an HTTPS origin without a path or credentials");
}
JS

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
umask 077
worker_secrets="$(mktemp)"
trap 'rm -f "$worker_secrets"' EXIT
jq -n '{
  WECHAT_GATEWAY_SECRET: env.WECHAT_GATEWAY_SECRET,
  WECHAT_GATEWAY_CONTROL_SECRET: env.WECHAT_GATEWAY_CONTROL_SECRET,
  API_ORIGIN: env.WECHAT_API_ORIGIN,
  WECHAT_RECEIVER_ENCRYPTION_KEY: env.WECHAT_RECEIVER_ENCRYPTION_KEY
}' > "$worker_secrets"
unset WECHAT_GATEWAY_SECRET WECHAT_GATEWAY_CONTROL_SECRET WECHAT_API_ORIGIN WECHAT_RECEIVER_ENCRYPTION_KEY

cd "$repo_root/turbo"
# Startup defaults to disabled regardless of the checked-in configuration.
# Enabling it requires explicit deployment input; first bootstrap requires /start.
pnpm --filter @okouai/wechat-gateway-worker exec wrangler deploy \
  --env "$gateway_environment" \
  --var "WECHAT_GATEWAY_ENABLED:$gateway_enabled" \
  --secrets-file "$worker_secrets" \
  --message "WeChat Gateway relay ${GITHUB_SHA:-manual} (enabled=$gateway_enabled)"
