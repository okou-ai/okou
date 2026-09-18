#!/usr/bin/env bash
# customize-rootfs.sh — Customize a template into a bootable rootfs.
#
# This script is called by the Rust runner binary after obtaining a reusable
# template from either R2 or a local build. It mounts the rootfs, injects
# guest binaries, resolver/host environment files, and the host-local proxy CA,
# then rebuilds trust stores. The resulting image is the bootable rootfs.
#
# Runs inside a private mount namespace so loopback/proc mounts are reclaimed
# by the kernel if the script is hard-killed before the EXIT trap runs.
#
# Usage:
#   bash customize-rootfs.sh \
#     --rootfs /path/to/rootfs.ext4.staging \
#     --ca-dir /path/to/ca \
#     --dns-nameserver 8.8.8.8 \
#     --guest /path/to/guest-agent /usr/local/bin/guest-agent \
#     [--guest SOURCE DESTINATION ...]

set -euo pipefail

readonly UNSHARE_SENTINEL="--__runner_unshared__"
if [[ "${1:-}" != "$UNSHARE_SENTINEL" ]]; then
  for cmd in sudo unshare; do
    if ! command -v "$cmd" &>/dev/null; then
      echo "error: $cmd not found (sudo is required to enter a mount namespace; unshare from util-linux)" >&2
      exit 1
    fi
  done
  exec sudo unshare --mount --propagation private \
    -- bash "$0" "$UNSHARE_SENTINEL" "$@"
fi
shift

ROOTFS=""
CA_DIR=""
DNS_NAMESERVER=""
GUEST_SOURCES=()
GUEST_DESTINATIONS=()
MOUNT_DIR=""
CHROOT_TMP=""
CHROOT_TMP_HOST=""
TMP_COUNTER=0

unmount_recursive_with_retries() {
  local target="$1"
  local attempt
  for attempt in 1 2 3; do
    if sudo umount -R "$target" 2>/dev/null; then
      return 0
    fi
    sleep 0.5
  done
  sudo umount -R "$target"
}

cleanup() {
  local status=$?
  local cleanup_failed=0

  if [[ -n "$CHROOT_TMP_HOST" ]]; then
    if ! sudo rm -rf --one-file-system "$CHROOT_TMP_HOST" 2>/dev/null; then
      cleanup_failed=1
    fi
  fi
  if [[ -n "$MOUNT_DIR" ]]; then
    # Unmount runtime bind mounts before the rootfs loop mount. /dev can bring
    # nested mounts such as pts/shm, so use recursive umount like build-template.sh.
    for target in "${MOUNT_DIR}/dev" "${MOUNT_DIR}/sys" "${MOUNT_DIR}/proc" "$MOUNT_DIR"; do
      if mountpoint -q "$target" 2>/dev/null; then
        if ! unmount_recursive_with_retries "$target"; then
          cleanup_failed=1
        fi
      fi
    done
    if ! rmdir "$MOUNT_DIR" 2>/dev/null; then
      cleanup_failed=1
    fi
  fi

  if [[ "$cleanup_failed" -ne 0 && "$status" -eq 0 ]]; then
    echo "error: rootfs cleanup failed" >&2
    status=1
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'echo "error: command failed at line ${LINENO}: ${BASH_COMMAND}" >&2' ERR

while [[ $# -gt 0 ]]; do
  case "$1" in
    --rootfs)             ROOTFS="$2";             shift 2 ;;
    --ca-dir)             CA_DIR="$2";             shift 2 ;;
    --dns-nameserver)     DNS_NAMESERVER="$2";     shift 2 ;;
    --guest)
      GUEST_SOURCES+=("$2")
      GUEST_DESTINATIONS+=("$3")
      shift 3
      ;;
    *) echo "error: unknown argument: $1" >&2; exit 1 ;;
  esac
done

for var in ROOTFS CA_DIR DNS_NAMESERVER; do
  if [[ -z "${!var}" ]]; then
    echo "error: --$(echo "$var" | tr '_' '-' | tr '[:upper:]' '[:lower:]') is required" >&2
    exit 1
  fi
done
if [[ ${#GUEST_SOURCES[@]} -eq 0 ]]; then
  echo "error: at least one --guest SOURCE DESTINATION is required" >&2
  exit 1
fi

missing=()
for cmd in sudo unshare mount umount mountpoint chroot mktemp sed grep; do
  if ! command -v "$cmd" &>/dev/null; then
    missing+=("$cmd")
  fi
done
if [[ ${#missing[@]} -gt 0 ]]; then
  echo "error: missing required dependencies: ${missing[*]}" >&2
  exit 1
fi

[[ -f "$ROOTFS" ]] || { echo "error: rootfs not found: $ROOTFS" >&2; exit 1; }
[[ -d "$CA_DIR" ]] || { echo "error: ca-dir not found: $CA_DIR" >&2; exit 1; }

# [sync:ca-constants] Keep in sync with: crates/runner/scripts/verify-rootfs.sh.
# Enforced by the `ca_constants_in_sync_across_scripts` test in cmd/build.rs.
CA_CERT_FILE="mitmproxy-ca-cert.pem"
CA_ROOTFS_DEST="usr/local/share/ca-certificates/vm0-proxy-ca.crt"
TOOL_EXEC_DEST="/usr/local/bin/guest-tool-exec"
CLAUDE_TOOL_HOOK_DEST="/etc/claude-code/managed-settings.d/90-tool-containment.json"
CODEX_TOOL_HOOK_DEST="/etc/codex/requirements.toml"

ca_cert="${CA_DIR}/${CA_CERT_FILE}"
[[ -f "$ca_cert" ]] || { echo "error: CA cert not found: $ca_cert" >&2; exit 1; }

validate_chroot_dest() {
  local dest="$1"
  if [[ "$dest" != /* || "$dest" == "/" ]]; then
    echo "error: rootfs destination must be an absolute non-root path: $dest" >&2
    exit 1
  fi
  local rel="${dest#/}"
  local component
  IFS='/' read -ra components <<< "$rel"
  for component in "${components[@]}"; do
    if [[ -z "$component" || "$component" == "." || "$component" == ".." ]]; then
      echo "error: unsafe rootfs destination component in: $dest" >&2
      exit 1
    fi
  done
}

resolve_chroot_dest() {
  local dest="$1"
  validate_chroot_dest "$dest"

  local parent="${dest%/*}"
  local leaf="${dest##*/}"
  if [[ -z "$parent" || "$parent" == "$dest" ]]; then
    parent="/"
  fi
  if [[ -z "$leaf" || "$leaf" == "." || "$leaf" == ".." ]]; then
    echo "error: unsafe rootfs destination basename in: $dest" >&2
    exit 1
  fi

  local resolved_parent
  resolved_parent="$(sudo chroot "$MOUNT_DIR" realpath -m -- "$parent")"
  case "$resolved_parent" in
    /proc|/proc/*|/sys|/sys/*|/dev|/dev/*)
      echo "error: rootfs destination resolves under runtime mount: $dest -> ${resolved_parent}" >&2
      exit 1
      ;;
  esac

  if [[ "$resolved_parent" == "/" ]]; then
    printf '/%s' "$leaf"
  else
    printf '%s/%s' "$resolved_parent" "$leaf"
  fi
}

next_tmp_path() {
  TMP_COUNTER=$((TMP_COUNTER + 1))
  printf '%s/file-%04d' "$CHROOT_TMP" "$TMP_COUNTER"
}

copy_into_chroot_tmp() {
  local src="$1"
  local tmp_path
  tmp_path="$(next_tmp_path)"
  sudo cp "$src" "${MOUNT_DIR}${tmp_path}"
  printf '%s' "$tmp_path"
}

write_into_chroot_tmp() {
  local tmp_path
  tmp_path="$(next_tmp_path)"
  sudo tee "${MOUNT_DIR}${tmp_path}" >/dev/null
  printf '%s' "$tmp_path"
}

install_chroot_file() {
  local tmp_path="$1"
  local dest="$2"
  local mode="$3"
  local safe_dest
  safe_dest="$(resolve_chroot_dest "$dest")"
  # Resolve parent symlinks inside the chroot so valid usrmerge paths such as
  # /sbin -> /usr/sbin behave like they do when the VM boots. Do not resolve
  # the final basename: remove it first so an existing target symlink is
  # replaced instead of followed. /proc, /sys, and /dev are not mounted yet, and
  # destinations that resolve under runtime mounts are rejected above.
  sudo chroot "$MOUNT_DIR" rm -f -- "$safe_dest"
  sudo chroot "$MOUNT_DIR" install -D -m "$mode" "$tmp_path" "$safe_dest"
  sudo rm -f "${MOUNT_DIR}${tmp_path}"
}

install_host_file() {
  local src="$1"
  local dest="$2"
  local mode="$3"
  local tmp_path
  tmp_path="$(copy_into_chroot_tmp "$src")"
  install_chroot_file "$tmp_path" "$dest" "$mode"
}

install_inline_file() {
  local dest="$1"
  local mode="$2"
  local tmp_path
  tmp_path="$(write_into_chroot_tmp)"
  install_chroot_file "$tmp_path" "$dest" "$mode"
}

MOUNT_DIR="$(mktemp -d)"
sudo mount -o loop "$ROOTFS" "$MOUNT_DIR"

CHROOT_TMP_HOST="$(sudo mktemp -d -p "$MOUNT_DIR" ".vm0-rootfs-customize.XXXXXX")"
CHROOT_TMP="/${CHROOT_TMP_HOST##*/}"
sudo chmod 700 "$CHROOT_TMP_HOST"

# Rootfs resolv.conf for the VM (single nameserver — UDP 53 redirected to dnsmasq).
printf 'nameserver %s\n' "$DNS_NAMESERVER" | install_inline_file "/etc/resolv.conf" 644

# The VM has no mDNS and resolv.conf only lists external nameservers, so
# localhost would fail to resolve without this.
printf '%s\n' \
  "127.0.0.1 localhost" \
  "::1 localhost" \
  | install_inline_file "/etc/hosts" 644

for index in "${!GUEST_SOURCES[@]}"; do
  install_host_file "${GUEST_SOURCES[$index]}" "${GUEST_DESTINATIONS[$index]}" 755
done

if ! sudo chroot "$MOUNT_DIR" test -x "$(resolve_chroot_dest "$TOOL_EXEC_DEST")"; then
  echo "error: tool executor guest destination is required: ${TOOL_EXEC_DEST}" >&2
  exit 1
fi

printf '%s\n' \
  '{' \
  '  "hooks": {' \
  '    "PreToolUse": [' \
  '      {' \
  '        "matcher": "Bash",' \
  '        "hooks": [' \
  '          {' \
  '            "type": "command",' \
  '            "command": "/usr/local/bin/guest-tool-exec hook",' \
  '            "timeout": 5' \
  '          }' \
  '        ]' \
  '      }' \
  '    ]' \
  '  }' \
  '}' \
  | install_inline_file "$CLAUDE_TOOL_HOOK_DEST" 644

printf '%s\n' \
  '[hooks]' \
  '' \
  '[[hooks.PreToolUse]]' \
  'matcher = "^Bash$"' \
  '' \
  '[[hooks.PreToolUse.hooks]]' \
  'type = "command"' \
  'command = "/usr/local/bin/guest-tool-exec hook"' \
  'timeout = 5' \
  | install_inline_file "$CODEX_TOOL_HOOK_DEST" 644

install_host_file "$ca_cert" "/${CA_ROOTFS_DEST}" 644

# /etc/environment is read by PAM for all login sessions.
# [sync:etc-environment] Keep in sync with:
# - .github/scripts/runner-behavior-exec-remote.sh (Test 10)
# - crates/guest-control-server/src/user.rs
printf '%s\n' \
  "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
  "LANG=C.UTF-8" \
  "RUSTUP_HOME=/usr/local/rustup" \
  "NPM_CONFIG_UPDATE_NOTIFIER=false" \
  "NODE_EXTRA_CA_CERTS=/${CA_ROOTFS_DEST}" \
  "SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt" \
  "REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt" \
  "CARGO_HTTP_CAINFO=/etc/ssl/certs/ca-certificates.crt" \
  | install_inline_file "/etc/environment" 644

# Match the rootfs customization chroot environment for trust-store updates.
# Keytool runs through the JVM, which uses /proc/self/exe for $ORIGIN RPATH
# handling and may use /dev devices such as urandom while opening the keystore.
# Mount these only after all rootfs file writes so destination validation cannot
# accidentally write through runtime bind mounts.
sudo mount --bind /proc "${MOUNT_DIR}/proc"
sudo mount --bind /sys "${MOUNT_DIR}/sys"
sudo mount --bind /dev "${MOUNT_DIR}/dev"
sudo chroot "$MOUNT_DIR" update-ca-certificates

ca_line=$(sed -n '2p' "${MOUNT_DIR}/${CA_ROOTFS_DEST}")
if [[ -z "$ca_line" ]] \
    || [[ "$ca_line" == -----BEGIN* ]] \
    || [[ "$ca_line" == -----END* ]]; then
  echo "error: proxy CA file malformed (line 2 is empty or a PEM framing line)" >&2
  exit 1
fi
if ! grep -qF -- "$ca_line" "${MOUNT_DIR}/etc/ssl/certs/ca-certificates.crt"; then
  echo "error: proxy CA not found in system bundle after update-ca-certificates" >&2
  exit 1
fi

sudo chroot "$MOUNT_DIR" keytool -importcert -trustcacerts \
  -keystore /etc/ssl/certs/java/cacerts \
  -storepass changeit -noprompt \
  -alias vm0-proxy-ca \
  -file "/${CA_ROOTFS_DEST}"

sudo rm -rf --one-file-system "$CHROOT_TMP_HOST"
CHROOT_TMP=""
CHROOT_TMP_HOST=""

echo "[OK] rootfs customized"
