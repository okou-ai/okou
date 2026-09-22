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

# Versions carried by this bundle. The runner rootfs installs the bundle by
# `cli` version and the API compares `piAgentRuntime` for API-first handoff
# parity, so both must be the release versions of the packed sources. The Pi
# SDK identity is the pinned upstream version plus a digest of the first-party
# patch set, because the same upstream pin can carry different patches.
release_version_pattern='^[0-9]+\.[0-9]+\.[0-9]+$'
cli_version="$(jq -er '.version' turbo/apps/cli/dist/package.json)"
pi_agent_runtime_version="$(jq -er '.version' turbo/packages/pi-agent-runtime/package.json)"
pi_sdk_pin="$(jq -er '.dependencies["@earendil-works/pi-coding-agent"]' turbo/packages/pi-agent-runtime/package.json)"
for pair in "cli:$cli_version" "piAgentRuntime:$pi_agent_runtime_version" "piSdk pin:$pi_sdk_pin"; do
  if [[ ! "${pair#*:}" =~ $release_version_pattern ]]; then
    echo "CLI artifact ${pair%%:*} version must be MAJOR.MINOR.PATCH: ${pair#*:}" >&2
    exit 1
  fi
done
pi_sdk_patch_files=()
while IFS= read -r patch_file; do
  pi_sdk_patch_files+=("$patch_file")
done < <(find turbo/patches -maxdepth 1 -type f -name '@earendil-works__*.patch' | LC_ALL=C sort)
if [[ ${#pi_sdk_patch_files[@]} -eq 0 ]]; then
  echo "CLI artifact expects the first-party Pi SDK patch set under turbo/patches" >&2
  exit 1
fi
pi_sdk_patch_set="$(cat "${pi_sdk_patch_files[@]}" | sha256sum | cut -c1-12)"
pi_sdk_version="${pi_sdk_pin}+okou.${pi_sdk_patch_set}"

jq -n \
  --arg commit_sha "$commit_sha" \
  --arg package_sha256 "$package_sha256" \
  --argjson package_size "$package_size" \
  --arg cli_version "$cli_version" \
  --arg pi_agent_runtime_version "$pi_agent_runtime_version" \
  --arg pi_sdk_version "$pi_sdk_version" \
  '{
    version: 1,
    commitSha: $commit_sha,
    package: {
      path: "package.tgz",
      sha256: $package_sha256,
      size: $package_size
    },
    versions: {
      cli: $cli_version,
      piAgentRuntime: $pi_agent_runtime_version,
      piSdk: $pi_sdk_version
    }
  }' > "$output_dir/manifest.json"

manifest_sha256="$(sha256sum "$output_dir/manifest.json" | cut -d ' ' -f 1)"
jq -n \
  --arg commit_sha "$commit_sha" \
  --arg manifest_sha256 "$manifest_sha256" \
  '{version: 1, commitSha: $commit_sha, manifestSha256: $manifest_sha256}' \
  > "$output_dir/ready.json"

bash .github/scripts/verify-okou-cli-artifact.sh "$output_dir" "$commit_sha"
