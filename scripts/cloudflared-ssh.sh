#!/bin/bash
# Manage Cloudflare Tunnels for SSH access to metal machines.
#
# Uses remotely-managed tunnels via the Cloudflare API.
# No local cloudflared or cert.pem needed — only an API token.
#
# Required environment variables (loaded from scripts/.env.local or exported):
#   CF_TUNNEL_API_TOKEN   — API token with Account:Cloudflare Tunnel:Edit + Zone:DNS:Edit + Zone:Zone:Read
#   CF_TUNNEL_ACCOUNT_ID  — Cloudflare account ID
#
# Usage:
#   scripts/cloudflared-ssh.sh provision <host> [--domain vm3.ai] [--user ubuntu] [--version 2026.10.4] [--sha256 <sha256>]
#   scripts/cloudflared-ssh.sh deprovision <host> [--domain vm3.ai] [--user ubuntu]
#
# Alternate versions require --sha256 for the target host's Debian architecture.
# The remote installer requires curl, sha256sum, mktemp, dpkg, and sudo.
#
# Examples:
#   scripts/cloudflared-ssh.sh provision prod-1.aws.vm3.ai
#   scripts/cloudflared-ssh.sh deprovision prod-1.aws.vm3.ai

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# --- Load .env.local ---
ENV_FILE="$SCRIPT_DIR/.env.local"
if [[ -f "$ENV_FILE" ]]; then
  # shellcheck source=/dev/null
  source "$ENV_FILE"
fi

DEFAULT_DOMAIN="vm3.ai"
DEFAULT_USER="ubuntu"
DEFAULT_VERSION="2026.10.4"
DEFAULT_SHA256_AMD64="3d73cd9f085de5a947fce8a72d0acc34a6a18cb23f369549b1cd0efc51121e98"
DEFAULT_SHA256_ARM64="d0d08a43521e52ba0707900ebe67314e7ca6f610b88024fe6562a408ab6a0f4d"

log() { echo -e "\033[1;34m[cloudflared-ssh]\033[0m $1" >&2; }
err() { echo -e "\033[1;31m[cloudflared-ssh]\033[0m $1" >&2; }

# --- Validate required environment variables ---
require_env() {
  for var in CF_TUNNEL_API_TOKEN CF_TUNNEL_ACCOUNT_ID; do
    if [[ -z "${!var:-}" ]]; then
      err "Required env var ${var} is not set"
      exit 1
    fi
  done
}

# --- Cloudflare API helper ---
cf_api() {
  local method="$1" endpoint="$2" data="${3:-}"
  local args=(-sSL -X "$method"
    -H "Authorization: Bearer ${CF_TUNNEL_API_TOKEN}"
    -H "Content-Type: application/json"
    "https://api.cloudflare.com/client/v4${endpoint}")
  [[ -n "$data" ]] && args+=(-d "$data")
  curl "${args[@]}"
}

# --- Resolve zone ID from domain name ---
get_zone_id() {
  local domain="$1"
  local zone_id
  zone_id=$(cf_api GET "/zones?name=${domain}" | jq -r '.result[0].id // empty')
  if [[ -z "$zone_id" ]]; then
    err "Could not find zone ID for domain '${domain}'. Check API token permissions."
    exit 1
  fi
  echo "$zone_id"
}

# --- Get tunnel ID by name (empty if not found) ---
get_tunnel_id() {
  local name="$1"
  cf_api GET "/accounts/${CF_TUNNEL_ACCOUNT_ID}/cfd_tunnel?name=${name}&is_deleted=false" \
    | jq -r '.result[0].id // empty'
}

# --- Get tunnel token ---
get_tunnel_token() {
  local tunnel_id="$1"
  cf_api GET "/accounts/${CF_TUNNEL_ACCOUNT_ID}/cfd_tunnel/${tunnel_id}/token" \
    | jq -r '.result // empty'
}

# --- Derive names from host ---
parse_host() {
  local host="$1" domain="$2"
  if ! [[ "$host" =~ ^([a-z0-9-]+\.)+${domain//./\\.}$ ]]; then
    err "Host '${host}' does not match expected pattern (e.g. dev-1.aws.${domain})"
    exit 1
  fi
  # dev-1.aws.vm3.ai -> dev-1-aws-ssh.vm3.ai
  local subdomain="${host%.${domain}}"
  TUNNEL_NAME="${subdomain//./-}-ssh"
  TUNNEL_FQDN="${TUNNEL_NAME}.${domain}"
}

# ==========================================
# Provision
# ==========================================
do_provision() {
  local host="" domain="$DEFAULT_DOMAIN" user="$DEFAULT_USER" version="$DEFAULT_VERSION"
  local sha256=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --domain)  domain="$2"; shift 2 ;;
      --user)    user="$2"; shift 2 ;;
      --version) version="$2"; shift 2 ;;
      --sha256)  sha256="$2"; shift 2 ;;
      -*)        err "Unknown option: $1"; exit 1 ;;
      *)         host="$1"; shift ;;
    esac
  done
  if [[ -z "$host" ]]; then
    err "Usage: $0 provision <host> [--domain vm3.ai] [--user ubuntu] [--version ${DEFAULT_VERSION}] [--sha256 <sha256>]"
    exit 1
  fi
  if [[ ! "$version" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]*$ ]]; then
    err "Invalid cloudflared version: ${version}"
    exit 1
  fi
  if [[ -n "$sha256" && ! "$sha256" =~ ^[0-9a-f]{64}$ ]]; then
    err "--sha256 must contain exactly 64 lowercase hexadecimal characters"
    exit 1
  fi
  if [[ "$version" != "$DEFAULT_VERSION" && -z "$sha256" ]]; then
    err "--sha256 is required when selecting a non-default cloudflared version"
    exit 1
  fi

  require_env
  parse_host "$host" "$domain"
  local zone_id
  zone_id=$(get_zone_id "$domain")
  log "Provisioning tunnel ${TUNNEL_FQDN} for ${host}"

  # Step 1: Create or reuse tunnel
  local tunnel_id
  tunnel_id=$(get_tunnel_id "$TUNNEL_NAME")

  if [[ -n "$tunnel_id" ]]; then
    log "Reusing existing tunnel: ${TUNNEL_NAME} (${tunnel_id})"
  else
    log "Creating tunnel: ${TUNNEL_NAME}"
    local create_resp
    create_resp=$(cf_api POST "/accounts/${CF_TUNNEL_ACCOUNT_ID}/cfd_tunnel" \
      "{\"name\":\"${TUNNEL_NAME}\",\"config_src\":\"cloudflare\",\"tunnel_secret\":\"$(openssl rand -base64 32)\"}")
    tunnel_id=$(echo "$create_resp" | jq -r '.result.id // empty')
    if [[ -z "$tunnel_id" ]]; then
      err "Failed to create tunnel: $(echo "$create_resp" | jq -r '.errors')"
      exit 1
    fi
    log "Created tunnel: ${tunnel_id}"
  fi

  # Step 2: Configure ingress rules
  log "Configuring ingress: ${TUNNEL_FQDN} -> ssh://localhost:22"
  local config_resp
  config_resp=$(cf_api PUT "/accounts/${CF_TUNNEL_ACCOUNT_ID}/cfd_tunnel/${tunnel_id}/configurations" \
    "{\"config\":{\"ingress\":[{\"hostname\":\"${TUNNEL_FQDN}\",\"service\":\"ssh://localhost:22\"},{\"service\":\"http_status:404\"}]}}")
  if [[ "$(echo "$config_resp" | jq -r '.success')" != "true" ]]; then
    err "Failed to configure ingress: $(echo "$config_resp" | jq -r '.errors')"
    exit 1
  fi

  # Step 3: Create or update DNS CNAME record
  log "Configuring DNS: ${TUNNEL_FQDN} -> ${tunnel_id}.cfargotunnel.com"
  local existing_record_id
  existing_record_id=$(cf_api GET "/zones/${zone_id}/dns_records?type=CNAME&name=${TUNNEL_FQDN}" \
    | jq -r '.result[0].id // empty')

  local dns_data="{\"type\":\"CNAME\",\"name\":\"${TUNNEL_FQDN}\",\"content\":\"${tunnel_id}.cfargotunnel.com\",\"proxied\":true}"
  local dns_resp
  if [[ -n "$existing_record_id" ]]; then
    dns_resp=$(cf_api PUT "/zones/${zone_id}/dns_records/${existing_record_id}" "$dns_data")
  else
    dns_resp=$(cf_api POST "/zones/${zone_id}/dns_records" "$dns_data")
  fi
  if [[ "$(echo "$dns_resp" | jq -r '.success')" != "true" ]]; then
    err "Failed to configure DNS: $(echo "$dns_resp" | jq -r '.errors')"
    exit 1
  fi
  log "DNS record configured"

  # Step 4: Get tunnel token
  local tunnel_token
  tunnel_token=$(get_tunnel_token "$tunnel_id")
  if [[ -z "$tunnel_token" ]]; then
    err "Failed to retrieve tunnel token"
    exit 1
  fi

  # Step 5: Deploy to host via SSH
  local remote="${user}@${host}"
  log "Deploying cloudflared ${version} to ${host}..."

  # Install cloudflared binary if needed
  ssh "$remote" bash -s -- "$version" \
    "${sha256:-$DEFAULT_SHA256_AMD64}" "${sha256:-$DEFAULT_SHA256_ARM64}" <<'INSTALL_SCRIPT'
set -euo pipefail
VERSION="$1"
ARCH="$(dpkg --print-architecture)"
case "$ARCH" in
  amd64) SHA256="$2" ;;
  arm64) SHA256="$3" ;;
  *)
    echo "Unsupported cloudflared Debian architecture: ${ARCH}" >&2
    exit 1
    ;;
esac
if ! cloudflared --version 2>/dev/null | grep -Fq "cloudflared version ${VERSION} "; then
  DOWNLOAD_DIR="$(mktemp -d)"
  trap 'rm -rf -- "$DOWNLOAD_DIR"' EXIT
  PACKAGE_PATH="${DOWNLOAD_DIR}/cloudflared.deb"
  echo "Downloading cloudflared ${VERSION}..."
  curl -fsSL --connect-timeout 10 --max-time 60 \
    "https://github.com/cloudflare/cloudflared/releases/download/${VERSION}/cloudflared-linux-${ARCH}.deb" \
    -o "$PACKAGE_PATH"
  if ! printf '%s  %s\n' "$SHA256" "$PACKAGE_PATH" | sha256sum --check --status; then
    echo "SHA-256 verification failed for cloudflared ${VERSION} (${ARCH})" >&2
    exit 1
  fi
  sudo dpkg -i "$PACKAGE_PATH"
else
  echo "cloudflared ${VERSION} already installed"
fi
INSTALL_SCRIPT

  # Install service with token (no config files needed for remotely-managed tunnels)
  ssh "$remote" bash -s -- "$tunnel_token" <<'SERVICE_SCRIPT'
set -euo pipefail
TOKEN="$1"
sudo cloudflared service uninstall 2>/dev/null || true
sudo cloudflared service install "$TOKEN"
sudo systemctl enable cloudflared
sudo systemctl start cloudflared

sleep 3
if systemctl is-active cloudflared > /dev/null 2>&1; then
  echo "cloudflared service is running"
else
  echo "ERROR: cloudflared service failed to start" >&2
  sudo journalctl -u cloudflared --no-pager -n 20 >&2
  exit 1
fi
SERVICE_SCRIPT

  log "Done! Tunnel ${TUNNEL_FQDN} is active (ID: ${tunnel_id})"
}

# ==========================================
# Deprovision
# ==========================================
do_deprovision() {
  local host="" domain="$DEFAULT_DOMAIN" user="$DEFAULT_USER"

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --domain) domain="$2"; shift 2 ;;
      --user)   user="$2"; shift 2 ;;
      -*)       err "Unknown option: $1"; exit 1 ;;
      *)        host="$1"; shift ;;
    esac
  done
  if [[ -z "$host" ]]; then
    err "Usage: $0 deprovision <host> [--domain vm3.ai] [--user ubuntu]"
    exit 1
  fi

  require_env
  parse_host "$host" "$domain"
  local zone_id
  zone_id=$(get_zone_id "$domain")
  log "Deprovisioning tunnel ${TUNNEL_FQDN}"

  local tunnel_id
  tunnel_id=$(get_tunnel_id "$TUNNEL_NAME")

  if [[ -z "$tunnel_id" ]]; then
    log "No tunnel found for ${TUNNEL_NAME}, nothing to do"
    return
  fi

  # Step 1: Uninstall service on host
  local remote="${user}@${host}"
  log "Stopping cloudflared service on ${host}..."
  ssh "$remote" "sudo cloudflared service uninstall 2>/dev/null || true" || \
    log "Warning: could not SSH to ${host} to uninstall service (host may be down)"

  # Step 2: Delete tunnel (cascade forces disconnect of active connections)
  log "Deleting tunnel ${TUNNEL_NAME} (${tunnel_id})..."
  local del_resp
  del_resp=$(cf_api DELETE "/accounts/${CF_TUNNEL_ACCOUNT_ID}/cfd_tunnel/${tunnel_id}?cascade=true")
  if [[ "$(echo "$del_resp" | jq -r '.success')" != "true" ]]; then
    err "Failed to delete tunnel: $(echo "$del_resp" | jq -r '.errors')"
    exit 1
  fi

  # Step 3: Delete DNS record
  local record_id
  record_id=$(cf_api GET "/zones/${zone_id}/dns_records?type=CNAME&name=${TUNNEL_FQDN}" \
    | jq -r '.result[0].id // empty')
  if [[ -n "$record_id" ]]; then
    local dns_del_resp
    dns_del_resp=$(cf_api DELETE "/zones/${zone_id}/dns_records/${record_id}")
    if [[ "$(echo "$dns_del_resp" | jq -r '.success')" != "true" ]]; then
      err "Warning: failed to delete DNS record: $(echo "$dns_del_resp" | jq -r '.errors')"
    else
      log "Deleted DNS record for ${TUNNEL_FQDN}"
    fi
  fi

  log "Done! Tunnel ${TUNNEL_NAME} removed"
}

# ==========================================
# Main
# ==========================================
if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <provision|deprovision> <host> [options]" >&2
  exit 1
fi

ACTION="$1"
shift

case "$ACTION" in
  provision)   do_provision "$@" ;;
  deprovision) do_deprovision "$@" ;;
  *)
    err "Unknown action: ${ACTION}"
    echo "Usage: $0 <provision|deprovision> <host> [options]" >&2
    exit 1
    ;;
esac
