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
  local file=$1
  if [ -s "$file" ] || [ -d "${file}.proxies" ]; then
    cloudflare_ssh_render_diagnostics master "$file" >&2
  else
    echo "SSH master diagnostics unavailable." >&2
  fi
}

cloudflare_ssh_redact_diagnostics() {
  cloudflare_ssh_render_diagnostics sanitize "$1"
}

cloudflare_ssh_sanitize_diagnostics() {
  cloudflare_ssh_redact_diagnostics "$1"
}

cloudflare_ssh_render_diagnostics() {
  local script_dir
  script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd) || return
  # Missing optional diagnostics must fail closed, never expose raw debug data.
  python3 "$script_dir/cloudflare-ssh-log.py" "$@" \
    || echo "SSH diagnostics could not be rendered; raw evidence omitted."
}

cloudflare_ssh_is_permanent_failure() {
  local file="$1"
  grep -Eiq \
    "Permission denied|Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|Bad configuration option|Unsupported option|no such identity|Identity file .* not accessible|Could not open a connection to your authentication agent|Cloudflare Access credentials rejected|Cloudflare Access SSH not configured|cloudflared is not installed" \
    "$file"
}
