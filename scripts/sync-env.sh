#!/usr/bin/env bash
set -e

# Sync all environment variables from .env.local.tpl files using 1Password CLI
#
# Usage: ./scripts/sync-env.sh

# Get script directory and project root
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# --- 1Password sync ---
sync_with_1password() {
  if ! command -v op >/dev/null 2>&1; then
    echo "Error: 1Password CLI (op) is not installed"
    echo "Install it from: https://developer.1password.com/docs/cli/get-started/"
    exit 1
  fi

  echo "Syncing all environment templates..."

  while IFS= read -r tpl_file; do
    output_file="${tpl_file%.tpl}"
    echo ""
    echo "Syncing: $tpl_file"
    echo "Output:  $output_file"
    op inject --force -i "$tpl_file" -o "$output_file"
    echo "✓ Synced successfully"
  done < <(find "$PROJECT_ROOT" -name ".env.local.tpl" -type f)

  echo ""
  echo "✓ All environment variables synced successfully"
}

API_ENV_LOCAL="$PROJECT_ROOT/turbo/apps/api/.env.local"
SCRIPTS_ENV_LOCAL="$PROJECT_ROOT/scripts/.env.local"

# --- Computed variables ---
# RUNNER_DEFAULT_GROUP is auto-derived from git email + hostname.
append_runner_group() {
  local env_file="$1" group_name="$2"
  [[ -f "$env_file" ]] || return 0

  # Remove old value and its comment header if present
  if grep -q "^RUNNER_DEFAULT_GROUP=" "$env_file" 2>/dev/null; then
    sed -i '/^# Self-hosted Runner$/d; /^RUNNER_DEFAULT_GROUP=/d' "$env_file"
  fi

  # Remove trailing blank lines before appending
  while [[ -s "$env_file" && -z "$(tail -c 1 "$env_file")" ]] && tail -1 "$env_file" | grep -q '^$'; do
    sed -i '$ d' "$env_file"
  done

  echo "" >> "$env_file"
  echo "# Self-hosted Runner" >> "$env_file"
  echo "RUNNER_DEFAULT_GROUP=${group_name}" >> "$env_file"
}

configure_runner_group() {
  # Derive from git email + hostname (e.g. alice@okou.ai on macbook -> alice-macbook)
  local username hostname_short
  username=$(git config user.email 2>/dev/null | sed 's/@.*//' | tr '[:upper:].' '[:lower:]-' | sed 's/-$//' || true)
  hostname_short=$("$SCRIPT_DIR/cn.sh")

  if [[ -z "$username" ]]; then
    echo "  ✗ RUNNER_DEFAULT_GROUP skipped (git user.email not configured)"
    return 0
  fi

  local group_name="vm0/local-${username}-${hostname_short}"

  append_runner_group "$API_ENV_LOCAL" "$group_name"
  append_runner_group "$SCRIPTS_ENV_LOCAL" "$group_name"
  echo "  ✓ RUNNER_DEFAULT_GROUP=${group_name}"
}

# --- SSH key provisioning ---
provision_ssh_key() {
  local key_ref="op://Development/vm0-metal-local/private_key"
  local key_path="$PROJECT_ROOT/.certs/vm0-metal-local.pem"

  echo ""
  echo "Provisioning SSH key..."
  mkdir -p "$PROJECT_ROOT/.certs"
  op read "${key_ref}?ssh-format=openssh" -o "$key_path" --force
  chmod 600 "$key_path"
  echo "  ✓ SSH key written to ${key_path}"
}

# --- Main ---
sync_with_1password
configure_runner_group
provision_ssh_key
