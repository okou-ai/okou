#!/usr/bin/env bash
set -euo pipefail

BIN_DIR=$1
EXECUTION_KEY=$2
ROOTFS_HASH=$3
: "${RUNNER_BEHAVIOR_DURABLE_UNIT:?durable owner unit is required}"
TEST_BIN="${BIN_DIR}/runner-host-cpu-fairness-${EXECUTION_KEY}"
BASE_DIR="/var/lib/vm0-runner/host-cpu-fairness/${EXECUTION_KEY}"
UNIT="runner-host-cpu-managed-${EXECUTION_KEY}"
# Pre-R5c and interim workflow revisions can share this host. Acquire both
# stable per-CPU inode namespaces in this order and never unlink their files.
LOCK_DIRS=(
  "/run/lock/vm0-host-cpu-fairness"
  "/run/lock/runner-host-cpu-fairness"
)
LOCK_FDS=()

case "$EXECUTION_KEY" in
  ''|*[!a-zA-Z0-9._-]*)
    echo "unsafe execution key" >&2
    exit 2
    ;;
esac

release_lock_fds() {
  local lock_fd
  for lock_fd in "$@"; do
    flock --unlock "$lock_fd" || true
    exec {lock_fd}>&-
  done
}

cleanup() {
  sudo systemctl stop "${UNIT}.service" 2>/dev/null || true
  sudo rm -f -- "$TEST_BIN"
  sudo rm -rf -- "$BASE_DIR"
  release_lock_fds "${LOCK_FDS[@]}"
}
trap cleanup EXIT

mapfile -t CPU_CANDIDATES < <(
  LC_ALL=C lscpu --parse=CPU,ONLINE | awk -F, '$2 == "Y" { print $1 }'
)
if [ "${#CPU_CANDIDATES[@]}" -eq 0 ]; then
  echo "host has no online CPUs" >&2
  exit 1
fi
for cpu in "${CPU_CANDIDATES[@]}"; do
  if [[ ! "$cpu" =~ ^[0-9]+$ ]]; then
    echo "invalid online CPU: $cpu" >&2
    exit 1
  fi
done
if [ "${#CPU_CANDIDATES[@]}" -gt 1 ]; then
  NONZERO_CPUS=()
  for cpu in "${CPU_CANDIDATES[@]}"; do
    if [ "$cpu" -ne 0 ]; then
      NONZERO_CPUS+=("$cpu")
    fi
  done
  CPU_CANDIDATES=("${NONZERO_CPUS[@]}")
fi

read -r SELECTION_HASH _ < <(printf '%s' "$EXECUTION_KEY" | cksum)
START_INDEX=$((SELECTION_HASH % ${#CPU_CANDIDATES[@]}))
sudo install -d -m 0755 -o "$(id -u)" -g "$(id -g)" "${LOCK_DIRS[@]}"

SELECTED_CPU=""
for ((offset = 0; offset < ${#CPU_CANDIDATES[@]}; offset++)); do
  candidate_index=$(((START_INDEX + offset) % ${#CPU_CANDIDATES[@]}))
  candidate_cpu=${CPU_CANDIDATES[$candidate_index]}
  candidate_lock_fds=()
  for lock_dir in "${LOCK_DIRS[@]}"; do
    exec {candidate_lock_fd}>"${lock_dir}/cpu-${candidate_cpu}.lock"
    if flock --nonblock "$candidate_lock_fd"; then
      candidate_lock_fds+=("$candidate_lock_fd")
      continue
    fi
    exec {candidate_lock_fd}>&-
    release_lock_fds "${candidate_lock_fds[@]}"
    continue 2
  done
  SELECTED_CPU=$candidate_cpu
  LOCK_FDS=("${candidate_lock_fds[@]}")
  break
done
if [ -z "$SELECTED_CPU" ]; then
  echo "no online host CPU is available for the fairness test" >&2
  exit 1
fi
echo "HOST_CPU_SELECTED_CPU=$SELECTED_CPU"

SYSTEMD_VERSION=$(systemd --version | awk 'NR == 1 { print $2 }')
case "$SYSTEMD_VERSION" in
  ''|*[!0-9]*)
    echo "cannot parse systemd version: $SYSTEMD_VERSION" >&2
    exit 1
    ;;
esac
if [ "$SYSTEMD_VERSION" -lt 254 ]; then
  echo "systemd 254+ is required, found $SYSTEMD_VERSION" >&2
  exit 1
fi

FIRECRACKER_DIR=$(find /var/lib/vm0-runner/firecracker \
  -mindepth 1 -maxdepth 1 -type d | sort -V | tail -1)
FIRECRACKER="${FIRECRACKER_DIR}/firecracker"
KERNEL=$(find "$FIRECRACKER_DIR" -maxdepth 1 -type f -name 'vmlinux-*' | sort | tail -1)
ROOTFS="/var/lib/vm0-runner/images/${ROOTFS_HASH}/rootfs.ext4"
for fixture in "$TEST_BIN" "$FIRECRACKER" "$KERNEL" "$ROOTFS"; do
  if [ ! -f "$fixture" ]; then
    echo "required host CPU fairness fixture is missing: $fixture" >&2
    exit 1
  fi
done

sudo modprobe nbd nbds_max=4096
sudo mkdir -p "$BASE_DIR"

echo "=== Managed weighted host CPU proof ==="
# Stop the delegated child before its durable owner releases the CPU locks.
# Bound the native workload even when the CI observer cannot reconnect.
sudo systemd-run \
  --wait \
  --collect \
  --pipe \
  "--unit=${UNIT}" \
  --property=Type=exec \
  "--property=BindsTo=${RUNNER_BEHAVIOR_DURABLE_UNIT}" \
  "--property=After=${RUNNER_BEHAVIOR_DURABLE_UNIT}" \
  --property=RuntimeMaxSec=180 \
  --property=Delegate=cpu \
  --property=DelegateSubgroup=control \
  "--property=AllowedCPUs=${SELECTED_CPU}" \
  --property=TimeoutStopSec=60 \
  "--setenv=OKOU_TEST_HOST_CPU_FIRECRACKER=${FIRECRACKER}" \
  "--setenv=OKOU_TEST_HOST_CPU_KERNEL=${KERNEL}" \
  "--setenv=OKOU_TEST_HOST_CPU_ROOTFS=${ROOTFS}" \
  "--setenv=OKOU_TEST_HOST_CPU_BASE_DIR=${BASE_DIR}" \
  "$TEST_BIN" --ignored --test-threads=1 --nocapture
