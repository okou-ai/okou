#!/usr/bin/env bash
set -euo pipefail

# Bind a fresh or input-equivalent cached package to the current source revision.
# Run from the repository root; package.tgz must already exist in output-dir.
if [[ "$#" -ne 2 || ! "$1" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Usage: $0 <commit-sha> <output-dir>" >&2
  exit 1
fi

commit_sha="$1"
output_dir="$2"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
rm -f "$output_dir/ready.json" "$output_dir/manifest.json"
identity="$(python3 "$script_dir/read-okou-cli-package-identity.py" "$output_dir/package.tgz" --verify-package)"
package_sha256="$(sha256sum "$output_dir/package.tgz" | cut -d ' ' -f 1)"
package_size="$(wc -c < "$output_dir/package.tgz" | tr -d '[:space:]')"

jq -n \
  --arg commit_sha "$commit_sha" \
  --arg package_sha256 "$package_sha256" \
  --argjson package_size "$package_size" \
  --argjson identity "$identity" \
  '{version: 1, commitSha: $commit_sha,
    package: {path: "package.tgz", sha256: $package_sha256, size: $package_size},
    versions: $identity.versions}' > "$output_dir/manifest.json"

manifest_sha256="$(sha256sum "$output_dir/manifest.json" | cut -d ' ' -f 1)"
jq -n \
  --arg commit_sha "$commit_sha" \
  --arg manifest_sha256 "$manifest_sha256" \
  '{version: 1, commitSha: $commit_sha, manifestSha256: $manifest_sha256}' \
  > "$output_dir/ready.json"

echo "Prepared CLI artifact for $commit_sha"
