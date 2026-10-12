#!/usr/bin/env bash
set -euo pipefail

if (($# < 1 || $# > 2)) || [[ "$1" != test && "$1" != production ]]; then
  echo "Usage: $0 <test|production> [true|false]" >&2
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
: "${DISCORD_APPLICATION_ID:?Discord application ID is required}"
: "${DISCORD_BOT_TOKEN:?Discord bot token is required}"
: "${DISCORD_GATEWAY_SECRET:?Gateway HMAC secret is required}"
: "${DISCORD_GATEWAY_CONTROL_SECRET:?Gateway control secret is required}"
: "${DISCORD_API_ORIGIN:?Canonical API origin is required}"

# Validate operator configuration before passing any secret to Cloudflare.
# Do not print credential values or provider responses.
node --input-type=module <<'JS'
const required = [
  "DISCORD_APPLICATION_ID",
  "DISCORD_BOT_TOKEN",
  "DISCORD_GATEWAY_SECRET",
  "DISCORD_GATEWAY_CONTROL_SECRET",
  "DISCORD_API_ORIGIN",
];
for (const key of required) {
  const value = process.env[key];
  if (!value || /\s/.test(value)) {
    throw new Error(`Invalid ${key}`);
  }
}
if (!/^[0-9]{17,20}$/.test(process.env.DISCORD_APPLICATION_ID)) {
  throw new Error("Invalid DISCORD_APPLICATION_ID");
}
for (const key of ["DISCORD_GATEWAY_SECRET", "DISCORD_GATEWAY_CONTROL_SECRET"]) {
  if (process.env[key].length < 32) {
    throw new Error(`${key} must have at least 32 characters`);
  }
}
if (new Set([
  process.env.DISCORD_BOT_TOKEN,
  process.env.DISCORD_GATEWAY_SECRET,
  process.env.DISCORD_GATEWAY_CONTROL_SECRET,
]).size !== 3) {
  throw new Error("Bot, HMAC, and control credentials must be distinct");
}
let origin;
try {
  origin = new URL(process.env.DISCORD_API_ORIGIN);
} catch {
  throw new Error("Invalid DISCORD_API_ORIGIN");
}
if (origin.protocol !== "https:" || origin.origin !== process.env.DISCORD_API_ORIGIN) {
  throw new Error("DISCORD_API_ORIGIN must be an HTTPS origin without a path or credentials");
}
JS

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
umask 077
worker_secrets="$(mktemp)"
trap 'rm -f "$worker_secrets"' EXIT
jq -n '{
  DISCORD_APPLICATION_ID: env.DISCORD_APPLICATION_ID,
  DISCORD_BOT_TOKEN: env.DISCORD_BOT_TOKEN,
  DISCORD_GATEWAY_SECRET: env.DISCORD_GATEWAY_SECRET,
  DISCORD_GATEWAY_CONTROL_SECRET: env.DISCORD_GATEWAY_CONTROL_SECRET,
  DISCORD_API_ORIGIN: env.DISCORD_API_ORIGIN
}' > "$worker_secrets"
unset DISCORD_APPLICATION_ID DISCORD_BOT_TOKEN DISCORD_GATEWAY_SECRET
unset DISCORD_GATEWAY_CONTROL_SECRET DISCORD_API_ORIGIN

cd "$repo_root/turbo"
# Startup defaults to disabled regardless of the checked-in configuration.
# Enabling it requires explicit deployment input; first bootstrap requires /start.
pnpm --filter @okouai/discord-gateway-worker exec wrangler deploy \
  --env "$gateway_environment" \
  --var "DISCORD_GATEWAY_ENABLED:$gateway_enabled" \
  --secrets-file "$worker_secrets" \
  --message "Discord Gateway relay ${GITHUB_SHA:-manual} (enabled=$gateway_enabled)"
