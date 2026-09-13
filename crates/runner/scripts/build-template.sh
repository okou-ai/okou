#!/usr/bin/env bash
# build-template.sh — Build a reusable ext4 template image.
#
# This script is called by the Rust runner binary. Its content is hashed as
# part of the template build-input hash, so any change here automatically
# invalidates the shared template cache.
#
# Rebuild marker: 2026-07-10 — comment-only change to force a template rebuild.
#
# Uses debootstrap + chroot instead of Docker to avoid the Docker daemon
# dependency and eliminate multiple I/O round-trips (tar export, tar extract,
# cp to ext4 mount). mkfs.ext4 -d populates the ext4 image directly from
# the rootfs directory.
#
# The build runs inside a private mount namespace (via `unshare --mount
# --propagation private`). Bind mounts of host /proc, /sys, /dev created
# for chroot operations are confined to this namespace — the host never
# sees them, and the kernel auto-unmounts everything when the script exits
# (including on SIGKILL, where the EXIT trap would not fire).
#
# `rm -rf --one-file-system` in the cleanup trap is a hard safety net: even
# if umount fails inside our namespace, rm refuses to cross the bind-mount
# boundary, eliminating any risk of unlinking host /dev entries through the
# shared devtmpfs superblock.
#
# The output rootfs file is chowned back to $SUDO_USER at the end so the
# runner can operate on it without sudo (matches pre-unshare ownership).
#
# Usage:
#   bash build-template.sh \
#     --output-dir /path/to/output \
#     --debootstrap-dir /path/to/cache \
#     --debootstrap-lock /path/to/cache/.lock \
#     --hash <input-hash> \
#     --rootfs-disk-mb 8192 \
#     [--mirror http://archive.ubuntu.com/ubuntu]

set -euo pipefail

# ---------------------------------------------------------------------------
# Re-exec inside a private mount namespace
# ---------------------------------------------------------------------------
#
# Uses a positional sentinel (not an env var) so we don't depend on sudoers
# allowing env preservation. The sentinel is prefixed with `__runner_` to make
# an accidental arg collision vanishingly unlikely.
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

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

OUTPUT_DIR=""
DEBOOTSTRAP_DIR=""
DEBOOTSTRAP_LOCK=""
INPUT_HASH=""
ROOTFS_DISK_MB=""
# Default mirror: archive.ubuntu.com only hosts amd64/i386;
# arm64 and other ports use ports.ubuntu.com.
if [[ "$(dpkg --print-architecture 2>/dev/null)" == "arm64" ]]; then
  MIRROR="http://ports.ubuntu.com/ubuntu-ports"
else
  MIRROR="http://archive.ubuntu.com/ubuntu"
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --output-dir)        OUTPUT_DIR="$2";        shift 2 ;;
    --debootstrap-dir)   DEBOOTSTRAP_DIR="$2";   shift 2 ;;
    --debootstrap-lock)  DEBOOTSTRAP_LOCK="$2";  shift 2 ;;
    --hash)              INPUT_HASH="$2";        shift 2 ;;
    --rootfs-disk-mb)    ROOTFS_DISK_MB="$2";    shift 2 ;;
    --mirror)            MIRROR="$2";            shift 2 ;;
    *) echo "error: unknown argument: $1" >&2; exit 1 ;;
  esac
done

for var in OUTPUT_DIR DEBOOTSTRAP_DIR DEBOOTSTRAP_LOCK INPUT_HASH ROOTFS_DISK_MB; do
  if [[ -z "${!var}" ]]; then
    echo "error: --$(echo "$var" | tr '_' '-' | tr '[:upper:]' '[:lower:]') is required" >&2
    exit 1
  fi
done

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

TEMPLATE_FILE="template.ext4"

# `$$` here is the *inner* (post-re-exec) bash PID — sudo forks, so the
# inner PID differs from any outer bash that may have invoked the script
# without the UNSHARE_SENTINEL. Do not read `$$` above the re-exec gate
# and expect the same value here.
TMP_TEMPLATE="${TEMPLATE_FILE}.tmp.$$"

# Paths derived from arguments
TEMPLATE_PATH="${OUTPUT_DIR}/${TEMPLATE_FILE}"
TMP_TEMPLATE_PATH="${OUTPUT_DIR}/${TMP_TEMPLATE}"
ROOTFS_DIR=""
CACHE_TMP_TAR=""

# Pinned versions (changes here invalidate the template cache via script hash)
GO_VERSION="1.27.1"
CLAUDE_CODE_VERSION="2.1.269"
CODEX_CLI_VERSION="0.154.0"
GWS_CLI_VERSION="0.22.5"
XURL_VERSION="1.3.1"
AGENT_BROWSER_VERSION="0.33.0-vm0.1"
AGENT_BROWSER_LINUX_X64_SHA256="a9e3fbe24c537960b9ac0d1f358224a10eb70d87a619aec7bcb1175222a46a18"
AGENT_BROWSER_LINUX_ARM64_SHA256="6a74dba04c299a69d564eae5aff67adc2ffc6fda5ddf672994ff75b73d64a9fe"
PNPM_VERSION="12.4.1"
CHROMIUM_VERSION="152.0.7977.82-1~deb12u1"
CHROMIUM_SECURITY_SNAPSHOT_URL="https://snapshot.debian.org/archive/debian-security/20260905T234553Z"

# ---------------------------------------------------------------------------
# Dependency checks
# ---------------------------------------------------------------------------

check_dependencies() {
  local missing=()

  for cmd in debootstrap flock sudo chroot mktemp stat mkfs.ext4 umount mountpoint unshare; do
    if ! command -v "$cmd" &> /dev/null; then
      missing+=("$cmd")
    fi
  done

  if [[ ${#missing[@]} -gt 0 ]]; then
    echo "error: missing required dependencies: ${missing[*]}" >&2
    exit 1
  fi

  echo "[OK] all dependencies found"
}

# ---------------------------------------------------------------------------
# Cleanup
# ---------------------------------------------------------------------------

readonly UMOUNT_ATTEMPTS=3
readonly UMOUNT_BACKOFF_SECONDS=0.5

cleanup_chroot() {
  if [[ -z "$ROOTFS_DIR" ]]; then
    return
  fi
  # -R unmounts recursively — bind-mounting /dev brings in sub-mounts
  # like /dev/shm, /dev/mqueue, /dev/hugepages that must be removed first.
  # Retry handles transient EBUSY from chroot subprocesses that haven't
  # fully exited yet. We buffer every attempt's stderr and dump all of
  # them on failure so diagnostic output covers the full sequence
  # (attempt 1 EPERM vs attempt 3 EBUSY etc.) rather than just the last.
  local target attempt err_log attempt_err
  local any_failure=0
  for target in "$ROOTFS_DIR/dev" "$ROOTFS_DIR/sys" "$ROOTFS_DIR/proc"; do
    # Skip if never mounted (e.g. early failure before debootstrap_build
    # installed the binds). Avoids retrying umount on plain dirs and
    # polluting CI logs with "not mounted" errors.
    if ! mountpoint -q "$target" 2>/dev/null; then
      continue
    fi
    err_log=""
    for (( attempt=1; attempt <= UMOUNT_ATTEMPTS; attempt++ )); do
      if attempt_err=$(sudo umount -R "$target" 2>&1); then
        break
      fi
      err_log+="attempt ${attempt}: ${attempt_err}"$'\n'
      (( attempt < UMOUNT_ATTEMPTS )) && sleep "$UMOUNT_BACKOFF_SECONDS"
    done
    # All attempts exhausted for this target — surface the buffered error
    # sequence and remember the failure, but keep going so the remaining
    # targets also get a chance to unmount.
    if (( attempt > UMOUNT_ATTEMPTS )); then
      printf '%s' "$err_log" >&2
      any_failure=1
    fi
  done
  # Non-zero return aborts via set -e in the pre-mkfs call (polluted ext4
  # is worse than a failed build). The EXIT trap records this as a cleanup
  # failure but still attempts the remainder of cleanup.
  return "$any_failure"
}

cleanup() {
  local status=$?
  local cleanup_failed=0

  echo "cleaning up..."
  # Always attempt every cleanup step. Preserve the original failing status,
  # but if the build itself succeeded, surface cleanup failures so a successful
  # run cannot leave a multi-GB debootstrap tree behind silently.
  if ! cleanup_chroot; then
    cleanup_failed=1
  fi
  if [[ -n "$ROOTFS_DIR" ]]; then
    # `--one-file-system`: if cleanup_chroot failed, $ROOTFS_DIR/{dev,sys,proc}
    # still bind-mount host devtmpfs/procfs/sysfs. Because bind mounts share
    # the source superblock (private propagation only confines mount events,
    # not inode data), a plain `rm -rf` could unlink host /dev/null etc.
    # This flag makes rm refuse to cross the bind-mount boundary, trading a
    # leaked tmp dir for guaranteed host safety. The leak itself is bounded:
    # the private mount namespace dies with this script and the kernel
    # reclaims both the mounts and (via systemd-tmpfiles) the /tmp entry.
    if ! sudo rm -rf --one-file-system "$ROOTFS_DIR"; then
      cleanup_failed=1
    fi
  fi
  if ! rm -f "$TMP_TEMPLATE_PATH"; then
    cleanup_failed=1
  fi
  if [[ -n "$CACHE_TMP_TAR" ]] && ! rm -f "$CACHE_TMP_TAR"; then
    cleanup_failed=1
  fi

  if [[ "$cleanup_failed" -ne 0 && "$status" -eq 0 ]]; then
    echo "error: template build cleanup failed" >&2
    status=1
  fi
  exit "$status"
}

trap cleanup EXIT
# Surface the failing command + line number on set -e-driven aborts. Fires
# only for commands that would propagate to set -e (i.e. not in `|| true`,
# `if`, etc.), so it doesn't spam on deliberately-handled failures.
trap 'echo "error: command failed at line ${LINENO}: ${BASH_COMMAND}" >&2' ERR

# ---------------------------------------------------------------------------
# Bootstrap Ubuntu 24.04 rootfs
# ---------------------------------------------------------------------------

debootstrap_cache_locked() {
  # Cache the base package tarball so repeated builds (e.g. after changing
  # a pinned version) skip the ~200 MB download from the Ubuntu mirror.
  local cache_tar="${DEBOOTSTRAP_DIR}/noble-$(dpkg --print-architecture).tar"
  if [[ -f "$cache_tar" ]]; then
    echo "using cached debootstrap tarball: $cache_tar"
    sudo debootstrap --unpack-tarball="$(realpath "$cache_tar")" noble "$ROOTFS_DIR" "$MIRROR"
    sudo touch "$cache_tar"
  else
    # --make-tarball downloads packages into a tarball without extracting.
    # It always exits non-zero ("cannot exec ...") because it skips the
    # second stage, so we check the tarball was created instead. Write to a
    # process-scoped temp file first: a cancelled build must not publish a
    # partial tarball under the stable cache name that another runner may reuse.
    # debootstrap validates the tarball suffix when unpacking, so keep the
    # process-scoped temp file ending in .tar instead of appending after it.
    # PIDs can repeat across concurrent build namespaces; the cache is shared.
    CACHE_TMP_TAR=$(mktemp "${cache_tar%.tar}.tmp.mktemp.XXXXXX.tar")
    sudo debootstrap --make-tarball="$CACHE_TMP_TAR" noble "$ROOTFS_DIR" "$MIRROR" || true
    if [[ ! -s "$CACHE_TMP_TAR" ]]; then
      echo "error: debootstrap --make-tarball failed to create $CACHE_TMP_TAR" >&2
      exit 1
    fi
    sudo debootstrap --unpack-tarball="$(realpath "$CACHE_TMP_TAR")" noble "$ROOTFS_DIR" "$MIRROR"
    mv -f "$CACHE_TMP_TAR" "$cache_tar"
    CACHE_TMP_TAR=""
  fi
}

debootstrap_build() {
  echo "bootstrapping Ubuntu 24.04 rootfs..."
  ROOTFS_DIR="$(mktemp -d)"

  # Only the shared tarball cache needs fleet-wide serialization. Release the
  # lock before package installation and mkfs so distinct template builds can
  # run concurrently after they have their private unpacked rootfs.
  local lock_fd
  exec {lock_fd}>>"$DEBOOTSTRAP_LOCK"
  flock "$lock_fd"
  debootstrap_cache_locked
  flock -u "$lock_fd"
  exec {lock_fd}>&-

  # Mount virtual filesystems for chroot operations.
  # --bind /dev recursively brings in sub-mounts (pts, shm, etc.);
  # cleanup_chroot uses umount -R to tear them all down.
  sudo mount --bind /proc "$ROOTFS_DIR/proc"
  sudo mount --bind /sys "$ROOTFS_DIR/sys"
  sudo mount --bind /dev "$ROOTFS_DIR/dev"

  # Copy host DNS for build-time package downloads. This is removed before
  # the reusable template is materialized so host-specific resolver state
  # never lands in the shared R2 template cache.
  sudo rm -f "$ROOTFS_DIR/etc/resolv.conf"
  sudo cp /etc/resolv.conf "$ROOTFS_DIR/etc/resolv.conf"

  echo "[OK] base system bootstrapped"
}

# ---------------------------------------------------------------------------
# Install APT packages
# ---------------------------------------------------------------------------

install_packages() {
  echo "installing packages..."

  # Step 1: Enable universe repo (debootstrap only enables main) and install
  # bootstrap tools needed to add external APT repositories.
  sudo chroot "$ROOTFS_DIR" bash -c 'set -e
  export DEBIAN_FRONTEND=noninteractive
  # debootstrap generates DEB822-format sources with "Components: main".
  # Add universe for packages like ripgrep.
  if [[ -f /etc/apt/sources.list.d/ubuntu.sources ]]; then
    sed -i "s/^Components: main$/Components: main universe/" /etc/apt/sources.list.d/ubuntu.sources
  else
    sed -i "s/ main$/ main universe/" /etc/apt/sources.list
  fi
  apt-get update
  apt-get install -y ca-certificates curl gnupg
  '

  # Step 2: Add external APT repositories (needs curl and gpg from step 1).
  sudo chroot "$ROOTFS_DIR" bash -c 'set -e
  # NodeSource repository (Node.js 24)
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor -o /usr/share/keyrings/nodesource.gpg
  echo "deb [signed-by=/usr/share/keyrings/nodesource.gpg] https://deb.nodesource.com/node_24.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  printf "Package: nodejs\nPin: origin deb.nodesource.com\nPin-Priority: 600\n" \
    > /etc/apt/preferences.d/nodesource

  # GitHub CLI repository
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    > /usr/share/keyrings/githubcli-archive-keyring.gpg
  chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list

  # PostgreSQL Global Development Group repository (PostgreSQL 18)
  curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
    | gpg --dearmor -o /usr/share/keyrings/postgresql.gpg
  echo "deb [signed-by=/usr/share/keyrings/postgresql.gpg] https://apt.postgresql.org/pub/repos/apt noble-pgdg main" \
    > /etc/apt/sources.list.d/pgdg.list
  '

  # Step 3: Install all APT packages in single pass.
  sudo chroot "$ROOTFS_DIR" bash -c 'set -e
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y \
    procps wget git ripgrep jq file iproute2 sudo ffmpeg \
    libreoffice-impress poppler-utils \
    fonts-noto-core fonts-noto-cjk fonts-noto-color-emoji \
    libnss3 p11-kit-modules tzdata-legacy unzip \
    nodejs \
    python3 python3-pip \
    ruby-full bundler \
    php php-cli php-common php-curl php-mbstring php-xml php-zip \
    default-jdk maven gradle \
    gcc g++ clang make cmake \
    postgresql-18 postgresql-contrib-18 postgresql-18-pgvector \
    redis-server \
    gh

  # Clean up third-party APT sources (no longer needed at runtime)
  rm -f /etc/apt/sources.list.d/nodesource.list \
       /etc/apt/preferences.d/nodesource \
       /usr/share/keyrings/nodesource.gpg \
       /etc/apt/sources.list.d/github-cli.list \
       /usr/share/keyrings/githubcli-archive-keyring.gpg \
       /etc/apt/sources.list.d/pgdg.list \
       /usr/share/keyrings/postgresql.gpg
  rm -rf /var/lib/apt/lists/* /var/cache/apt/*
  '

  # Chromium from Debian Bookworm security (Ubuntu 24.04 snap stub does not work).
  # Installed separately to avoid cross-distro dependency conflicts.
  # Pin to a Debian security snapshot for reproducible Chromium packages.
  sudo chroot "$ROOTFS_DIR" env \
    CHROMIUM_VERSION="$CHROMIUM_VERSION" \
    CHROMIUM_SECURITY_SNAPSHOT_URL="$CHROMIUM_SECURITY_SNAPSHOT_URL" \
    bash -c 'set -e
    export DEBIAN_FRONTEND=noninteractive
    {
      curl -fsSL https://ftp-master.debian.org/keys/archive-key-12.asc
      curl -fsSL https://ftp-master.debian.org/keys/archive-key-12-security.asc
    } \
      | gpg --dearmor -o /usr/share/keyrings/debian-bookworm.gpg
    cat > /etc/apt/sources.list.d/debian-bookworm.list <<EOF
deb [signed-by=/usr/share/keyrings/debian-bookworm.gpg] http://deb.debian.org/debian bookworm main
deb [check-valid-until=no signed-by=/usr/share/keyrings/debian-bookworm.gpg] ${CHROMIUM_SECURITY_SNAPSHOT_URL}/ bookworm-security main
EOF
    apt-get update
    apt-get install -y -t bookworm \
      chromium="${CHROMIUM_VERSION}" \
      chromium-common="${CHROMIUM_VERSION}" \
      chromium-sandbox="${CHROMIUM_VERSION}"
    rm -f /etc/apt/sources.list.d/debian-bookworm.list \
         /usr/share/keyrings/debian-bookworm.gpg
    rm -rf /var/lib/apt/lists/* /var/cache/apt/*
  '

  # Make NSS-based applications (Chromium, Firefox) trust the system CA store.
  # Replace Mozilla built-in trust module with p11-kit so proxy CA certs
  # injected via update-ca-certificates are trusted by all applications.
  sudo chroot "$ROOTFS_DIR" bash -c 'set -e
    find /usr/lib -name libnssckbi.so -exec sh -c \
      '\''p11=$(find /usr/lib -name p11-kit-trust.so | head -1) && ln -sf "$p11" "$1"'\'' _ {} \;
  '

  echo "[OK] packages installed"
}

# ---------------------------------------------------------------------------
# Install non-APT runtimes and tools
# ---------------------------------------------------------------------------

install_runtimes() {
  echo "installing language runtimes and CLIs..."

  # User account (Ubuntu 24.04 ships 'ubuntu' at UID 1000; remove it first)
  sudo chroot "$ROOTFS_DIR" bash -c '
    userdel -r ubuntu 2>/dev/null || true
    useradd -m -u 1000 -s /bin/bash user
    usermod -aG sudo,postgres user
    echo "user ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers
    passwd -d user
  '

  # Go (official tarball)
  sudo chroot "$ROOTFS_DIR" bash -c "
    ARCH=\$(dpkg --print-architecture)
    curl -fsSL \"https://go.dev/dl/go${GO_VERSION}.linux-\${ARCH}.tar.gz\" -o /tmp/go.tar.gz
    tar -C /usr/local -xzf /tmp/go.tar.gz
    rm /tmp/go.tar.gz
    ln -s /usr/local/go/bin/go /usr/local/bin/go
    ln -s /usr/local/go/bin/gofmt /usr/local/bin/gofmt
    echo 'export PATH=\$PATH:\$HOME/go/bin' > /etc/profile.d/golang.sh
  "

  # Rust (stable toolchain via rustup)
  sudo chroot "$ROOTFS_DIR" bash -c '
    export RUSTUP_HOME=/usr/local/rustup
    export CARGO_HOME=/usr/local/cargo
    curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs \
      | sh -s -- -y --default-toolchain stable --no-modify-path
    for bin in /usr/local/cargo/bin/*; do ln -s "$bin" /usr/local/bin/; done
    printf "export RUSTUP_HOME=/usr/local/rustup\nexport CARGO_HOME=\$HOME/.cargo\nexport PATH=\$PATH:\$HOME/.cargo/bin\n" \
      > /etc/profile.d/rust.sh
  '

  # PHP Composer
  sudo chroot "$ROOTFS_DIR" bash -c '
    curl -sS https://getcomposer.org/installer | php -- --install-dir=/usr/local/bin --filename=composer
  '

  # Claude Code CLI (standalone Bun-compiled binary)
  sudo chroot "$ROOTFS_DIR" bash -c "
    ARCH=\$(dpkg --print-architecture)
    case \"\$ARCH\" in
      amd64) PLATFORM=\"linux-x64\" ;;
      arm64) PLATFORM=\"linux-arm64\" ;;
      *) echo \"Unsupported architecture: \$ARCH\" >&2; exit 1 ;;
    esac
    DOWNLOAD_BASE_URL=\"https://downloads.claude.ai/claude-code-releases\"
    curl -fsSL \"\${DOWNLOAD_BASE_URL}/${CLAUDE_CODE_VERSION}/\${PLATFORM}/claude\" -o /usr/local/bin/claude
    CHECKSUM=\$(curl -fsSL \"\${DOWNLOAD_BASE_URL}/${CLAUDE_CODE_VERSION}/manifest.json\" \
      | jq -r \".platforms[\\\"\$PLATFORM\\\"].checksum\")
    echo \"\${CHECKSUM}  /usr/local/bin/claude\" | sha256sum -c -
    chmod +x /usr/local/bin/claude
  "

  # agent-browser CLI (vm0 fork with native system root certificate support)
  sudo chroot "$ROOTFS_DIR" bash -c "
    ARCH=\$(dpkg --print-architecture)
    case \"\$ARCH\" in
      amd64)
        PLATFORM=\"linux-x64\"
        CHECKSUM=\"${AGENT_BROWSER_LINUX_X64_SHA256}\"
        ;;
      arm64)
        PLATFORM=\"linux-arm64\"
        CHECKSUM=\"${AGENT_BROWSER_LINUX_ARM64_SHA256}\"
        ;;
      *) echo \"Unsupported architecture: \$ARCH\" >&2; exit 1 ;;
    esac
    DOWNLOAD_BASE_URL=\"https://github.com/vm0-ai/agent-browser/releases/download/v${AGENT_BROWSER_VERSION}\"
    curl -fsSL \"\${DOWNLOAD_BASE_URL}/agent-browser-\${PLATFORM}\" -o /tmp/agent-browser
    echo \"\${CHECKSUM}  /tmp/agent-browser\" | sha256sum -c -
    install -m 0755 /tmp/agent-browser /usr/local/bin/agent-browser
    rm /tmp/agent-browser
    test \"\$(/usr/local/bin/agent-browser --version)\" = \"agent-browser ${AGENT_BROWSER_VERSION}\"
  "

  # npm global packages (combined into one install)
  sudo chroot "$ROOTFS_DIR" bash -c "
    npm install -g \
      @googleworkspace/cli@${GWS_CLI_VERSION} \
      @xdevplatform/xurl@${XURL_VERSION} \
      @openai/codex@${CODEX_CLI_VERSION} \
      pnpm@${PNPM_VERSION}
    npm cache clean --force
  "

  echo "[OK] runtimes and CLIs installed"
}

# ---------------------------------------------------------------------------
# ext4 image creation
# ---------------------------------------------------------------------------

create_ext4() {
  echo "creating ext4 image..."

  local content_bytes
  content_bytes=$(sudo du -sb "$ROOTFS_DIR" | cut -f1)
  local image_bytes=$(( ROOTFS_DISK_MB * 1024 * 1024 ))

  if (( image_bytes < content_bytes )); then
    local content_mb=$(( content_bytes / 1024 / 1024 ))
    echo "error: rootfs_disk_mb (${ROOTFS_DISK_MB} MiB) is smaller than rootfs content (${content_mb} MiB)" >&2
    exit 1
  fi

  # Derive a deterministic UUID from the input hash. ext4 uses the UUID as
  # the htree seed for directory hashing — a fixed UUID ensures identical
  # block layout for identical content, making the rootfs reproducible.
  local fs_uuid="${INPUT_HASH:0:8}-${INPUT_HASH:8:4}-${INPUT_HASH:12:4}-${INPUT_HASH:16:4}-${INPUT_HASH:20:12}"

  # mktemp -d creates 0700; ext4 root inode must be 0755 for non-root access.
  sudo chmod 755 "$ROOTFS_DIR"

  # Create ext4 image populated directly from directory (no loopback mount needed)
  truncate -s "$image_bytes" "$TMP_TEMPLATE_PATH"
  mkfs.ext4 -F -q -U "$fs_uuid" -d "$ROOTFS_DIR" "$TMP_TEMPLATE_PATH"

  echo "[OK] ext4 image created"
}

# ---------------------------------------------------------------------------
# Main (runs inside the private mount namespace set up by the re-exec above)
# ---------------------------------------------------------------------------

check_dependencies
debootstrap_build
install_packages
install_runtimes

# Remove build-time host resolver state before producing the reusable rootfs
# template. The VM resolver config is injected by customize-rootfs.sh.
sudo rm -f "$ROOTFS_DIR/etc/resolv.conf"
sudo touch "$ROOTFS_DIR/etc/resolv.conf"
sudo chmod 644 "$ROOTFS_DIR/etc/resolv.conf"

# Unmount virtual filesystems before creating ext4 image
cleanup_chroot

create_ext4

# Move into place
mv "$TMP_TEMPLATE_PATH" "$TEMPLATE_PATH"

# The unshare re-exec escalates to root, so the template file was created
# as root. Restore ownership to the invoking user so downstream callers
# (runner reading/replacing the file) don't need sudo. SUDO_USER is set
# by the outer sudo at re-exec time; if it is missing or "root" the
# chown is a no-op.
#
# Don't fail the build on chown error: the artifact is valid on disk and
# mode 644 makes it world-readable, so a mis-ownership is cosmetic — the
# runner can still consume it. Warn instead so operators can investigate.
if [[ -n "${SUDO_USER:-}" && "$SUDO_USER" != "root" ]]; then
  chown "$SUDO_USER" "$TEMPLATE_PATH" \
    || echo "warning: chown $SUDO_USER $TEMPLATE_PATH failed; file remains root-owned" >&2
fi

# Report size
SIZE=$(stat -c%s "$TEMPLATE_PATH")
SIZE_MB=$((SIZE / 1024 / 1024))
echo "[OK] template built: ${TEMPLATE_PATH} (${SIZE_MB} MiB)"
