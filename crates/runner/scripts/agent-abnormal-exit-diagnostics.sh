# Best-effort guest-side diagnostics for unexplained agent bootstrap exits.
# Keep this script intentionally narrow: it must not collect environment values,
# command lines with environments, or /proc/*/environ content.
set +e

section() {
  printf '\n== %s ==\n' "$1"
}

section identity
id 2>&1
uname -a 2>&1
pwd 2>&1

section guest-agent-binary
ls -l /usr/local/bin/guest-agent 2>&1
stat /usr/local/bin/guest-agent 2>&1
if command -v file >/dev/null 2>&1; then
  file /usr/local/bin/guest-agent 2>&1
else
  echo "file: unavailable"
fi
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum /usr/local/bin/guest-agent 2>&1
else
  echo "sha256sum: unavailable"
fi

section resources
ulimit -a 2>&1
df -h 2>&1
echo "VM0_DF_BLOCKS_V1"
if [ -e /home/user/workspace ]; then
  df -P -k / /home/user/workspace 2>&1
else
  df -P -k / 2>&1
fi
echo "VM0_DF_INODES_V1"
if [ -e /home/user/workspace ]; then
  df -P -i / /home/user/workspace 2>&1
else
  df -P -i / 2>&1
fi
if command -v free >/dev/null 2>&1; then
  free -m 2>&1
elif [ -r /proc/meminfo ]; then
  head -20 /proc/meminfo 2>&1
else
  echo "memory: unavailable"
fi
if [ -r /proc/sys/fs/file-nr ]; then
  cat /proc/sys/fs/file-nr 2>&1
else
  echo "/proc/sys/fs/file-nr: unavailable"
fi

section rootfs-usage
# Defined by the Runner alongside this script; no guest file is materialized.
rootfs_usage 2>/dev/null || echo "sampler_failed_or_timed_out"

section processes
if command -v ps >/dev/null 2>&1; then
  ps -e --no-headers 2>/dev/null | wc -l
else
  ls -1 /proc 2>/dev/null | grep -E '^[0-9]+$' | wc -l
fi

section dmesg
dmesg 2>&1 | tail -50
