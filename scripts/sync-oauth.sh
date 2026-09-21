#!/usr/bin/env bash
set -euo pipefail

# Sync OAuth connector credentials from /tmp/oauth-credentials to 1Password and GitHub
#
# Credentials file format at /tmp/oauth-credentials/<PROVIDER>:
#   PROVIDER_OAUTH_SLUG=...              (optional, dev/test app slug)
#   PROVIDER_OAUTH_CLIENT_ID=...         (dev/test app client ID)
#   PROVIDER_OAUTH_CLIENT_SECRET=...     (dev/test app client secret)
#   PROVIDER_OAUTH_SLUG_PROD=...         (optional, production app slug)
#   PROVIDER_OAUTH_CLIENT_ID_PROD=...    (production app client ID)
#   PROVIDER_OAUTH_CLIENT_SECRET_PROD=...  (production app client secret)
#
# Non-_PROD fields → Development vault + GitHub repo-level vars/secrets
# _PROD fields     → Production vault + GitHub production environment vars/secrets
#
# Usage: ./scripts/sync-oauth.sh [PROVIDER_NAME]

DEV_VAULT="Development"
PROD_VAULT="Production"

# --- Helpers ---

require_tool() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Error: $1 is not installed."
    exit 1
  fi
}

op_safe_edit() {
  local vault="$1" item="$2"
  shift 2
  local err
  if err=$(op item edit "$item" --vault "$vault" "$@" 2>&1 >/dev/null); then
    return 0
  fi
  if [[ "$err" == *"isn't an item in"* ]] || [[ "$err" == *"not found"* ]]; then
    # Item doesn't exist — create it
    op item create --vault "$vault" --title "$item" --category Login "$@" >/dev/null
  elif [[ "$err" == *"Password item requires ps value"* ]]; then
    op item edit "$item" --vault "$vault" "password[password]=placeholder" "$@" >/dev/null
  else
    echo "$err" >&2
    return 1
  fi
}

mask() { local v="$1"; echo "${v:0:4}***"; }

# --- Main ---

require_tool op
require_tool gh

PROVIDER="${1:-}"
if [[ -z "$PROVIDER" ]]; then
  read -rp "Enter OAuth provider name (e.g., MONDAY): " PROVIDER
fi

PROVIDER="$(echo "$PROVIDER" | tr '[:lower:]' '[:upper:]')"
if [[ -z "$PROVIDER" ]]; then
  echo "Error: provider name cannot be empty."
  exit 1
fi

# Derive 1Password item name: lowercase + underscores → hyphens
# Special cases where the provider prefix differs from the item name:
#   GH → github  (GitHub OAuth connector lives alongside GitHub App creds)
ITEM_NAME="$(echo "$PROVIDER" | tr '[:upper:]' '[:lower:]' | tr '_' '-')"
case "$PROVIDER" in
  GH) ITEM_NAME="github" ;;
esac
DEV_ITEM="$ITEM_NAME"
PROD_ITEM="$ITEM_NAME"

CREDS_FILE="/tmp/oauth-credentials/${PROVIDER}"
VAR_SLUG="${PROVIDER}_OAUTH_SLUG"
VAR_ID="${PROVIDER}_OAUTH_CLIENT_ID"
VAR_SECRET="${PROVIDER}_OAUTH_CLIENT_SECRET"
VAR_SLUG_PROD="${PROVIDER}_OAUTH_SLUG_PROD"
VAR_ID_PROD="${PROVIDER}_OAUTH_CLIENT_ID_PROD"
VAR_SECRET_PROD="${PROVIDER}_OAUTH_CLIENT_SECRET_PROD"

echo ""
echo "Provider:      ${PROVIDER}"
echo "1P item:       ${ITEM_NAME}"
echo "Creds file:    ${CREDS_FILE}"
echo ""

# --- Load or create credentials file ---

if [[ ! -f "$CREDS_FILE" ]]; then
  echo "Credentials file not found. Creating template at ${CREDS_FILE}..."
  mkdir -p /tmp/oauth-credentials
  cat > "$CREDS_FILE" <<EOF
${VAR_SLUG}=
${VAR_ID}=
${VAR_SECRET}=
${VAR_SLUG_PROD}=
${VAR_ID_PROD}=
${VAR_SECRET_PROD}=
EOF
  echo ""
  echo "Please fill in the values in ${CREDS_FILE}, then re-run:"
  echo ""
  echo "  bash scripts/sync-oauth.sh ${PROVIDER}"
  echo ""
  exit 0
fi

# Source the credentials file
# shellcheck disable=SC1090
source "$CREDS_FILE"

dev_slug="${!VAR_SLUG:-}"
dev_id="${!VAR_ID:-}"
dev_secret="${!VAR_SECRET:-}"
prod_slug="${!VAR_SLUG_PROD:-}"
prod_id="${!VAR_ID_PROD:-}"
prod_secret="${!VAR_SECRET_PROD:-}"

# Check required fields
missing=()
[[ -z "$dev_id" ]]     && missing+=("${VAR_ID}")
[[ -z "$dev_secret" ]] && missing+=("${VAR_SECRET}")
[[ -z "$prod_id" ]]    && missing+=("${VAR_ID_PROD}")
[[ -z "$prod_secret" ]] && missing+=("${VAR_SECRET_PROD}")

if [[ ${#missing[@]} -gt 0 ]]; then
  echo "The following required values are missing in ${CREDS_FILE}:"
  for m in "${missing[@]}"; do
    echo "  - $m"
  done
  echo ""
  echo "Please fill them in, then re-run: bash scripts/sync-oauth.sh ${PROVIDER}"
  exit 1
fi

# --- Preview ---

echo "=== Values loaded ==="
echo "  ${VAR_ID} = ${dev_id}"
echo "  ${VAR_SECRET} = $(mask "$dev_secret")"
[[ -n "$dev_slug" ]] && echo "  ${VAR_SLUG} = ${dev_slug}"
echo "  ${VAR_ID_PROD} = ${prod_id}"
echo "  ${VAR_SECRET_PROD} = $(mask "$prod_secret")"
[[ -n "$prod_slug" ]] && echo "  ${VAR_SLUG_PROD} = ${prod_slug}"
echo ""

# --- Sign in to 1Password ---

echo "Signing in to 1Password..."
eval "$(op signin)"

echo ""
echo "=== Actions to be taken ==="
echo ""
echo "  # Dev: 1Password '${DEV_VAULT}/${DEV_ITEM}' + GitHub repo-level"
echo "  ${VAR_ID} = ${dev_id}"
echo "  ${VAR_SECRET} = $(mask "$dev_secret")"
[[ -n "$dev_slug" ]] && echo "  ${VAR_SLUG} = ${dev_slug}"
echo ""
echo "  # Prod: 1Password '${PROD_VAULT}/${PROD_ITEM}' + GitHub production environment"
echo "  ${VAR_ID} = ${prod_id}"
echo "  ${VAR_SECRET} = $(mask "$prod_secret")"
[[ -n "$prod_slug" ]] && echo "  ${VAR_SLUG_PROD} = ${prod_slug}"
echo ""
read -rp "Proceed? [y/N] " confirm
if [[ ! "$confirm" =~ ^[Yy] ]]; then
  echo "Aborted."
  exit 0
fi

echo ""
echo "=== Syncing to 1Password ==="

# Dev vault
op_safe_edit "$DEV_VAULT" "$DEV_ITEM" \
  "${VAR_ID}[text]=${dev_id}" \
  "${VAR_SECRET}[password]=${dev_secret}"
echo "  Updated ${DEV_VAULT}/${DEV_ITEM}: ${VAR_ID}, ${VAR_SECRET}"

if [[ -n "$dev_slug" ]]; then
  op_safe_edit "$DEV_VAULT" "$DEV_ITEM" "${VAR_SLUG}[text]=${dev_slug}"
  echo "  Updated ${DEV_VAULT}/${DEV_ITEM}: ${VAR_SLUG}"
fi

# Prod vault (field names without _PROD suffix — same key, different vault)
op_safe_edit "$PROD_VAULT" "$PROD_ITEM" \
  "${VAR_ID}[text]=${prod_id}" \
  "${VAR_SECRET}[password]=${prod_secret}"
echo "  Updated ${PROD_VAULT}/${PROD_ITEM}: ${VAR_ID}, ${VAR_SECRET}"

if [[ -n "$prod_slug" ]]; then
  op_safe_edit "$PROD_VAULT" "$PROD_ITEM" "${VAR_SLUG}[text]=${prod_slug}"
  echo "  Updated ${PROD_VAULT}/${PROD_ITEM}: ${VAR_SLUG}"
fi

echo ""
echo "=== Syncing to GitHub ==="

# Dev: repo-level variable + secret (uses base name, not _PROD)
echo "$dev_id" | gh variable --repo okou-ai/okou set "${VAR_ID}"
echo "  Set repo variable: ${VAR_ID}"

echo "$dev_secret" | gh secret --repo okou-ai/okou set "${VAR_SECRET}"
echo "  Set repo secret:   ${VAR_SECRET}"

if [[ -n "$dev_slug" ]]; then
  echo "$dev_slug" | gh variable --repo okou-ai/okou set "${VAR_SLUG}"
  echo "  Set repo variable: ${VAR_SLUG}"
fi

# Prod: production environment variable + secret
echo "$prod_id" | gh variable --repo okou-ai/okou set "${VAR_ID}" -e production
echo "  Set production variable: ${VAR_ID}"

echo "$prod_secret" | gh secret --repo okou-ai/okou set "${VAR_SECRET}" -e production
echo "  Set production secret:   ${VAR_SECRET}"

if [[ -n "$prod_slug" ]]; then
  echo "$prod_slug" | gh variable --repo okou-ai/okou set "${VAR_SLUG}" -e production
  echo "  Set production variable: ${VAR_SLUG}"
fi

echo ""
echo "=== Done ==="
echo "OAuth credentials for ${PROVIDER} synced to 1Password and GitHub."
