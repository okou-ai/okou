#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
script="${repo_root}/.github/scripts/artifacts/verify-okou-app-artifact.sh"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

expected_commit_sha="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
artifact_dir="${tmp_dir}/artifact"
mkdir -p "${artifact_dir}/assets"

printf '<!doctype html>\n' > "${artifact_dir}/index.html"
printf 'console.log("app");\n' > "${artifact_dir}/assets/app.js"

index_sha="$(sha256sum "${artifact_dir}/index.html" | cut -d ' ' -f 1)"
index_size="$(stat -c '%s' "${artifact_dir}/index.html")"
asset_sha="$(sha256sum "${artifact_dir}/assets/app.js" | cut -d ' ' -f 1)"
asset_size="$(stat -c '%s' "${artifact_dir}/assets/app.js")"

jq -n \
  --arg commit_sha "$expected_commit_sha" \
  --arg index_sha "$index_sha" \
  --argjson index_size "$index_size" \
  --arg asset_sha "$asset_sha" \
  --argjson asset_size "$asset_size" \
  '{
    version: 1,
    commitSha: $commit_sha,
    files: [
      {path: "index.html", sha256: $index_sha, size: $index_size},
      {path: "assets/app.js", sha256: $asset_sha, size: $asset_size}
    ]
  }' > "${artifact_dir}/manifest.json"

manifest_sha="$(sha256sum "${artifact_dir}/manifest.json" | cut -d ' ' -f 1)"
jq -n \
  --arg commit_sha "$expected_commit_sha" \
  --arg manifest_sha "$manifest_sha" \
  '{version: 1, commitSha: $commit_sha, manifestSha256: $manifest_sha}' \
  > "${artifact_dir}/ready.json"

bash "$script" "$artifact_dir" "$expected_commit_sha"

tampered_dir="${tmp_dir}/tampered"
cp -a "$artifact_dir" "$tampered_dir"
printf 'tampered\n' >> "${tampered_dir}/assets/app.js"
if bash "$script" "$tampered_dir" "$expected_commit_sha" >/dev/null 2>&1; then
  echo "expected a tampered artifact file to be rejected" >&2
  exit 1
fi

wrong_commit_sha="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
if bash "$script" "$artifact_dir" "$wrong_commit_sha" >/dev/null 2>&1; then
  echo "expected an artifact for another commit to be rejected" >&2
  exit 1
fi

bad_ready_dir="${tmp_dir}/bad-ready"
cp -a "$artifact_dir" "$bad_ready_dir"
jq '.manifestSha256 = "0000000000000000000000000000000000000000000000000000000000000000"' \
  "${artifact_dir}/ready.json" > "${bad_ready_dir}/ready.json"
if bash "$script" "$bad_ready_dir" "$expected_commit_sha" >/dev/null 2>&1; then
  echo "expected a mismatched manifest digest to be rejected" >&2
  exit 1
fi

echo "verify-okou-app-artifact tests passed"
