#!/usr/bin/env bash

cloudflare_ssh_master_diagnostics_file() {
  local user=$1 host=$2 control_path=${3:-}
  local target_key temp_root
  if [ -n "$control_path" ]; then
    printf '%s.stderr\n' "$control_path"
    return
  fi

  target_key=$(printf '%s@%s' "$user" "${host,,}" \
    | sha256sum | cut -c1-24)
  temp_root="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
  printf '%s/cloudflare-ssh-master-%s.stderr\n' "${temp_root%/}" "$target_key"
}

cloudflare_ssh_emit_master_diagnostics() {
  local file=$1 probe_file=${2:-}
  if [ -s "$file" ] || { [ -n "$probe_file" ] && [ -s "$probe_file" ]; }; then
    echo "----- SSH master stderr and probe stderr (combined last 100 lines, at most 64 KiB, redacted) -----" >&2
    {
      if [ -s "$file" ]; then
        tail -n 100 "$file"
      fi
      if [ -n "$probe_file" ] && [ -s "$probe_file" ]; then
        echo "----- command-channel probe stderr -----"
        tail -n 20 "$probe_file"
      fi
    } \
      | cloudflare_ssh_sanitize_diagnostics - \
      | tail -n 100 \
      | tail -c 65536 >&2
  else
    echo "SSH master diagnostics unavailable." >&2
  fi
}

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
