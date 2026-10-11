#!/usr/bin/env bash
set -euo pipefail

# Build, deploy, and manage a dev runner on a metal host via Cloudflare Tunnel.
#
# Reads RUNNER_LOCAL_HOST, RUNNER_DEFAULT_GROUP, and OFFICIAL_RUNNER_SECRET
# from scripts/.env.local. Uses scripts/cf-ssh.sh for all remote operations.
#
# Usage:
#   scripts/dev-runner.sh deploy   Build, upload, and start the runner
#   scripts/dev-runner.sh remove   Stop and uninstall the runner
#
# Set RUNNER_TARGET_TRIPLE to force a supported runner target. When unset,
# deploy derives the target from the remote host architecture.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CRATES_DIR="$PROJECT_ROOT/crates"
. "$PROJECT_ROOT/.github/scripts/runner-image-target.sh"
. "$PROJECT_ROOT/.github/scripts/runner-guest-binaries.sh"

log() { echo "[runner] $1" >&2; }

shell_env_assignments() {
  local output=""
  local name
  local value

  while (($#)); do
    name="$1"
    value="${2-}"
    shift 2

    value=${value//\'/\'\\\'\'}
    output+="$name='$value' "
  done

  printf "%s" "${output% }"
}

# --- Load config ---
ENV_FILE="$SCRIPT_DIR/.env.local"
if [[ ! -f "$ENV_FILE" ]]; then
  log "Error: $ENV_FILE not found. Run scripts/sync-env.sh first."
  exit 1
fi
# shellcheck source=/dev/null
source "$ENV_FILE"

HOST="${RUNNER_LOCAL_HOST:?RUNNER_LOCAL_HOST not set in $ENV_FILE}"
SSH_USER="${RUNNER_LOCAL_USER:-ubuntu}"

# --- Opaque local service suffix from RUNNER_DEFAULT_GROUP ---
RUNNER_GROUP="${RUNNER_DEFAULT_GROUP:?RUNNER_DEFAULT_GROUP not set in $ENV_FILE}"
# vm0/local-alice-macbook -> alice-macbook
RUNNER_SERVICE_SUFFIX="${RUNNER_GROUP##*/}"

REMOTE_BIN_DIR="/var/lib/vm0-runner/bin/${RUNNER_SERVICE_SUFFIX}"
RUNNER_BIN="sudo $REMOTE_BIN_DIR/runner"
RUNNER_DIR="/var/lib/vm0-runner/runners/$RUNNER_SERVICE_SUFFIX"

CF_SSH="$SCRIPT_DIR/cf-ssh.sh"
SSH_KEY="$PROJECT_ROOT/.certs/vm0-metal-local.pem"
if [[ ! -f "$SSH_KEY" ]]; then
  log "Error: SSH key not found at $SSH_KEY"
  log "Run 'scripts/sync-env.sh' to provision it from 1Password."
  exit 1
fi
ssh_cmd() { "$CF_SSH" "$HOST" -l "$SSH_USER" -i "$SSH_KEY" "$@"; }

remote_uname_m() {
  local remote_arch
  remote_arch=$(ssh_cmd "uname -m")
  printf '%s\n' "$remote_arch" | tail -n1 | tr -d '\r'
}

select_runner_target() {
  local remote_arch derived_target selected_target expected_arch

  if [[ -n "${RUNNER_TARGET_TRIPLE:-}" ]]; then
    runner_image_validate_target "$RUNNER_TARGET_TRIPLE" || return $?
    expected_arch=$(runner_image_expected_uname_m "$RUNNER_TARGET_TRIPLE") || return $?
  fi

  remote_arch=$(remote_uname_m)
  if ! derived_target=$(runner_image_target_for_uname_m "$remote_arch" 2>/dev/null); then
    log "Error: unsupported remote architecture for $HOST: $remote_arch"
    return 2
  fi

  if [[ -n "${RUNNER_TARGET_TRIPLE:-}" ]]; then
    if [[ "$expected_arch" != "$remote_arch" ]]; then
      log "Error: RUNNER_TARGET_TRIPLE=$RUNNER_TARGET_TRIPLE expects remote architecture $expected_arch, but $HOST reported $remote_arch"
      return 2
    fi
    selected_target="$RUNNER_TARGET_TRIPLE"
  else
    selected_target="$derived_target"
  fi

  log "Remote architecture: $remote_arch"
  log "Runner target: $selected_target"
  printf '%s\n' "$selected_target"
}

# --- Commands ---

cmd_deploy() {
  RUNNER_SECRET="${OFFICIAL_RUNNER_SECRET:?OFFICIAL_RUNNER_SECRET not set in $ENV_FILE}"
  TARGET=$(select_runner_target)
  # alice-macbook -> https://tunnel-alice-macbook-www.vm7.ai
  API_URL="https://tunnel-${RUNNER_SERVICE_SUFFIX#local-}-www.vm7.ai"
  log "Runner service: $RUNNER_SERVICE_SUFFIX (group: $RUNNER_GROUP, api: $API_URL)"

  runner_guest_binaries_load
  local guest_cargo_args=()
  local guest_env=()
  local index
  for index in "${!RUNNER_GUEST_PACKAGES[@]}"; do
    guest_cargo_args+=("-p" "${RUNNER_GUEST_PACKAGES[$index]}")
    guest_env+=("${RUNNER_GUEST_PATH_ENVS[$index]}=target/$TARGET/ci/${RUNNER_GUEST_BINARIES[$index]}")
  done

  # Build guests
  log "Building guest binaries..."
  cd "$CRATES_DIR"
  cargo build --profile ci --target "$TARGET" "${guest_cargo_args[@]}"

  # Build runner
  log "Building runner with embedded guests..."
  env "${guest_env[@]}" cargo build --profile ci --target "$TARGET" -p runner

  BINARY="$CRATES_DIR/target/$TARGET/ci/runner"
  log "Binary: $BINARY ($(du -h "$BINARY" | cut -f1))"

  # Stop old service before uploading (avoids "Text file busy").
  # Try --force first (new runner), fall back to no-flag (old runner).
  log "Stopping old service..."
  ssh_cmd "$RUNNER_BIN service stop --name $RUNNER_SERVICE_SUFFIX --force" || ssh_cmd "$RUNNER_BIN service stop --name $RUNNER_SERVICE_SUFFIX" || true

  # Upload
  log "Deploying to $SSH_USER@$HOST..."
  ssh_cmd "sudo mkdir -p $REMOTE_BIN_DIR"
  ssh_cmd "sudo install -m 755 /dev/stdin $REMOTE_BIN_DIR/runner" < "$BINARY"

  # Setup (idempotent, downloads firecracker/kernel if missing)
  log "Running setup..."
  ssh_cmd "$RUNNER_BIN setup"

  # R2 creds passed as sudo args so they survive sudo's env scrub. Empty
  # values are treated as "unset" by r2_cache.rs, matching
  # ansible/playbooks/build-runner.yml's R2 env block. `build` uses them to
  # pull a cached template instead of rebuilding it locally.
  R2_BUILD_ENV="$(shell_env_assignments \
    R2_ACCOUNT_ID "${R2_ACCOUNT_ID:-}" \
    R2_ACCESS_KEY_ID "${R2_ACCESS_KEY_ID:-}" \
    R2_SECRET_ACCESS_KEY "${R2_SECRET_ACCESS_KEY:-}" \
    R2_USER_STORAGES_BUCKET_NAME "${R2_USER_STORAGES_BUCKET_NAME:-}")"

  # Clean up old images (keep 3 most recent deploys)
  ssh_cmd "sudo $REMOTE_BIN_DIR/runner gc --keep-latest 3"

  # Build unified image (rootfs + snapshot)
  PROFILES=("vm0/default")
  CONFIG_ARGS=""

  for PROFILE in "${PROFILES[@]}"; do
    log "Building $PROFILE..."
    BUILD_LOG=$(mktemp)
    ssh_cmd "sudo $R2_BUILD_ENV $REMOTE_BIN_DIR/runner build --profile $PROFILE" | tee "$BUILD_LOG"
    ROOTFS_HASH=$(grep '^rootfs_hash=' "$BUILD_LOG" | cut -d= -f2)
    SNAPSHOT_HASH=$(grep '^snapshot_hash=' "$BUILD_LOG" | cut -d= -f2)
    rm -f "$BUILD_LOG"

    if [[ -z "$ROOTFS_HASH" || -z "$SNAPSHOT_HASH" ]]; then
      log "Error: failed to extract rootfs/snapshot hash for $PROFILE"
      exit 1
    fi
    log "$PROFILE: rootfs=$ROOTFS_HASH snapshot=$SNAPSHOT_HASH"

    CONFIG_ARGS+=" --profile $PROFILE --rootfs-hash $ROOTFS_HASH --snapshot-hash $SNAPSHOT_HASH"
  done

  # Generate config
  log "Generating config..."
  ssh_cmd "$RUNNER_BIN config \
    $CONFIG_ARGS \
    --hostname $HOST \
    --group $RUNNER_GROUP \
    --runner-dirname $RUNNER_SERVICE_SUFFIX \
    --api-url $API_URL \
    --token vm0_official_${RUNNER_SECRET}"

  # Start service
  log "Starting new service..."
  LOCAL_FLAG=""
  MOCK_FLAG=""
  if [[ "${LOCAL_MODE:-}" == "1" ]]; then
    LOCAL_FLAG="--local"
    MOCK_FLAG="--env USE_MOCK_CLAUDE=true"
  fi
  ssh_cmd "$RUNNER_BIN service start --name $RUNNER_SERVICE_SUFFIX \
    --config $RUNNER_DIR/runner.yaml $LOCAL_FLAG $MOCK_FLAG"

  log "Waiting for Runner readiness..."
  ssh_cmd "$RUNNER_BIN service wait-running --name $RUNNER_SERVICE_SUFFIX --timeout-secs 120" >/dev/null

  log "Done! Runner service $RUNNER_SERVICE_SUFFIX deployed to $HOST"
}

cmd_submit() {
  PROFILE="${2:?Usage: $0 submit <profile> <prompt>}"
  PROMPT="${3:?Usage: $0 submit <profile> <prompt>}"
  log "Submitting job through runner service $RUNNER_SERVICE_SUFFIX (profile: $PROFILE, prompt: $PROMPT)..."
  # Use printf %q to safely escape the prompt for remote shell
  ESCAPED_PROMPT=$(printf '%q' "$PROMPT")
  ssh_cmd "$RUNNER_BIN local submit --group $RUNNER_GROUP --profile $PROFILE --prompt $ESCAPED_PROMPT --timeout 120"
}

cmd_deploy_local() {
  LOCAL_MODE=1 cmd_deploy
}

cmd_exec() {
  RUN_ID="${2:?Usage: $0 exec <run-id> <command...>}"
  COMMAND="${3:?Usage: $0 exec <run-id> <command...>}"
  shift 3
  COMMAND="$COMMAND $*"
  log "Executing in sandbox $RUN_ID: $COMMAND"
  ESCAPED_COMMAND=$(printf '%q' "$COMMAND")
  ssh_cmd "$RUNNER_BIN exec $RUN_ID -- $ESCAPED_COMMAND"
}

cmd_remove() {
  log "Removing runner service $RUNNER_SERVICE_SUFFIX from $HOST..."

  ssh_cmd "$RUNNER_BIN service stop --name $RUNNER_SERVICE_SUFFIX --force" || ssh_cmd "$RUNNER_BIN service stop --name $RUNNER_SERVICE_SUFFIX" || true
  ssh_cmd "sudo rm -rf $REMOTE_BIN_DIR $RUNNER_DIR"

  log "Done! Runner service $RUNNER_SERVICE_SUFFIX removed from $HOST"
}

# --- Main ---
COMMAND="${1:-}"
case "$COMMAND" in
  deploy) cmd_deploy ;;
  deploy-local) cmd_deploy_local ;;
  submit) cmd_submit "$@" ;;
  exec) cmd_exec "$@" ;;
  remove) cmd_remove ;;
  *)
    log "Usage: $0 {deploy|deploy-local|submit|exec|remove}"
    exit 1
    ;;
esac
