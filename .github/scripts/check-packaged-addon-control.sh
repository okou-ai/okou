#!/usr/bin/env bash
# Exercise the exact standalone artifact selected by Runner's dependency pins.
set -euo pipefail

repo_root=$(git rev-parse --show-toplevel)
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
test_dir=$(mktemp -d -t addon-control-runtime.XXXXXXXX)
trap 'rm -rf -- "$test_dir"' EXIT

curl --fail --location --proto '=https' --tlsv1.2 --retry 3 --max-time 180 \
  "https://downloads.mitmproxy.org/$version/mitmproxy-$version-linux-$arch.tar.gz" \
  --output "$test_dir/mitmproxy.tar.gz"
test "$(stat -c %s "$test_dir/mitmproxy.tar.gz")" = "$archive_size"
printf '%s  %s\n' "$archive_sha" "$test_dir/mitmproxy.tar.gz" | sha256sum --check
tar -xzf "$test_dir/mitmproxy.tar.gz" -C "$test_dir" mitmdump
test "$(stat -c %s "$test_dir/mitmdump")" = "$binary_size"
printf '%s  %s\n' "$binary_sha" "$test_dir/mitmdump" | sha256sum --check

cd "$repo_root/crates/runner/mitm-addon"
MITMDUMP_CONTROL_TEST_BINARY="$test_dir/mitmdump" \
  uv run --no-sync python -m pytest tests/packaged_control.py -v
