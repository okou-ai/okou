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

package_sha256="$(sha256sum "$output_dir/package.tgz" | cut -d ' ' -f 1)"
package_size="$(wc -c < "$output_dir/package.tgz" | tr -d '[:space:]')"

# Installation identity belongs to the actual package, not a second workspace
# read after packing. Commit provenance and byte integrity remain external.
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
identity="$(python3 "${script_dir}/read-okou-cli-package-identity.py" "$output_dir/package.tgz")"

jq -n \
  --arg commit_sha "$commit_sha" \
  --arg package_sha256 "$package_sha256" \
  --argjson package_size "$package_size" \
  --argjson identity "$identity" \
  '{
    version: 1,
    commitSha: $commit_sha,
    package: {
      path: "package.tgz",
      sha256: $package_sha256,
      size: $package_size
    },
    versions: $identity.versions,
    sessionConstruction: $identity.sessionConstruction
  }' > "$output_dir/manifest.json"

manifest_sha256="$(sha256sum "$output_dir/manifest.json" | cut -d ' ' -f 1)"
jq -n \
  --arg commit_sha "$commit_sha" \
  --arg manifest_sha256 "$manifest_sha256" \
  '{version: 1, commitSha: $commit_sha, manifestSha256: $manifest_sha256}' \
  > "$output_dir/ready.json"

bash .github/scripts/verify-okou-cli-artifact.sh "$output_dir" "$commit_sha"
