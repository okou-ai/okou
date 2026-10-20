#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 2 ]]; then
  echo "Usage: $0 <commit-sha> <output-dir>" >&2
  exit 1
fi

commit_sha="$1"
output_dir="$2"

if [[ ! "$commit_sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo "CLI artifact commit must be a full lowercase SHA-1: $commit_sha" >&2
  exit 1
fi

mkdir -p "$output_dir"
output_dir="$(cd "$output_dir" && pwd -P)"
rm -f \
  "$output_dir/package.tgz" \
  "$output_dir/manifest.json" \
  "$output_dir/ready.json"

package_filename="$({
  cd turbo/apps/cli/dist
  npm pack --pack-destination "$output_dir" --json
} | jq -er '.[0].filename | select(type == "string" and length > 0)')"
mv "$output_dir/$package_filename" "$output_dir/package.tgz"

# Installation identity belongs to the actual package, not a second workspace
# read after packing. Commit provenance and byte integrity remain external.
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bash "$script_dir/finalize-okou-cli-artifact.sh" "$commit_sha" "$output_dir"
