#!/usr/bin/env bash

cloudflare_ssh_redact_diagnostics() {
  local file="$1"
  sed -E \
    -e 's/(--secret(=|[[:space:]]+))[^[:space:]]+/\1[redacted]/g' \
    -e 's/(--id(=|[[:space:]]+))[^[:space:]]+/\1[redacted]/g' \
    -e 's/(CF_ACCESS_CLIENT_SECRET=)[^[:space:]]+/\1[redacted]/g' \
    -e 's/(CF_ACCESS_CLIENT_ID=)[^[:space:]]+/\1[redacted]/g' \
    -e 's/(TUNNEL_SERVICE_TOKEN_SECRET=)[^[:space:]]+/\1[redacted]/g' \
    -e 's/(TUNNEL_SERVICE_TOKEN_ID=)[^[:space:]]+/\1[redacted]/g' \
    -e 's/(Authorization:[[:space:]]*Bearer[[:space:]]+)[^[:space:]]+/\1[redacted]/Ig' \
    "$file"
}

cloudflare_ssh_sanitize_diagnostics() {
  local file="$1"
  cloudflare_ssh_redact_diagnostics "$file" \
    | sed -E 's/^::(error|warning)( title=[^:]*)?:://'
}

cloudflare_ssh_is_permanent_failure() {
  local file="$1"
  grep -Eiq \
    "Permission denied|Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|Bad configuration option|Unsupported option|no such identity|Identity file .* not accessible|Could not open a connection to your authentication agent|Cloudflare Access credentials rejected|Cloudflare Access SSH not configured|cloudflared is not installed" \
    "$file"
}
