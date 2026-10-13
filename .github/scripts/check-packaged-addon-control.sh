#!/usr/bin/env bash
# Exercise the exact standalone artifact selected by Runner's dependency pins.
# Run from a repository checkout with Bash, coreutils, curl, tar and locked uv.
# --cache-key prints archive identity without downloading or running pytest.
# MITMPROXY_CONTROL_TEST_ARCHIVE optionally reuses an archive; its parent must exist.
# Archive and binary validation failures stop before pytest, including on cache hits.
set -euo pipefail

if (($# > 0)); then
  if (($# != 1)) || [[ "$1" != "--cache-key" ]]; then
    echo "Usage: $0 [--cache-key]" >&2
    exit 2
  fi
fi

repo_root=$(git rev-parse --show-toplevel)
# shellcheck source=.github/scripts/runner-image-target.sh
source "$repo_root/.github/scripts/runner-image-target.sh"
target=$(runner_image_target_for_uname_m "$(uname -m)")
arch=$(runner_image_expected_uname_m "$target")
deps="$repo_root/crates/runner/src/deps.rs"

constant() {
  awk -v name="$1" '
    $1 == "pub" && $2 == "const" && $3 == name ":" {
      sub(/^.*= */, "")
      if ($0 == "") getline
      gsub(/[";_[:space:]]/, "")
      print
      found = 1
      exit
    }
    END { if (!found) exit 1 }
  ' "$deps"
}

version=$(constant MITMPROXY_VERSION)
archive_sha=$(constant "MITMPROXY_ARCHIVE_SHA256_${arch^^}")
archive_size=$(constant "MITMPROXY_ARCHIVE_SIZE_${arch^^}")
binary_sha=$(constant "MITMDUMP_SHA256_${arch^^}")
binary_size=$(constant "MITMDUMP_SIZE_${arch^^}")

if (($# == 1)); then
  printf 'mitmproxy-archive-v1-%s-%s-%s\n' "$version" "$arch" "$archive_sha"
  exit 0
fi

test_dir=$(mktemp -d -t addon-control-runtime.XXXXXXXX)
trap 'rm -rf -- "$test_dir"' EXIT
archive="${MITMPROXY_CONTROL_TEST_ARCHIVE:-$test_dir/mitmproxy.tar.gz}"

if [[ ! -f "$archive" ]]; then
  bash "$repo_root/.github/scripts/download-verified.sh" \
    "https://downloads.mitmproxy.org/$version/mitmproxy-$version-linux-$arch.tar.gz" \
    "$archive_sha" "$archive"
fi
test "$(stat -c %s "$archive")" = "$archive_size"
printf '%s  %s\n' "$archive_sha" "$archive" | sha256sum --check
tar -xzf "$archive" -C "$test_dir" mitmdump
test "$(stat -c %s "$test_dir/mitmdump")" = "$binary_size"
printf '%s  %s\n' "$binary_sha" "$test_dir/mitmdump" | sha256sum --check

cd "$repo_root/crates/runner/mitm-addon"
MITMDUMP_CONTROL_TEST_BINARY="$test_dir/mitmdump" \
  uv run --no-sync python -m pytest tests/packaged_control.py -v
