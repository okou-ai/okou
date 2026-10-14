#!/usr/bin/env bash
set -euo pipefail

if (( $# != 2 )); then
  echo "usage: $0 <artifact-directory> <expected-commit-sha>" >&2
  exit 1
fi

artifact_dir="$1"
expected_commit_sha="$2"
manifest_path="${artifact_dir}/manifest.json"
ready_path="${artifact_dir}/ready.json"

if [[ ! "$expected_commit_sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo "expected commit SHA must be a full lowercase SHA-1" >&2
  exit 1
fi

if [[ ! -f "$manifest_path" || ! -f "$ready_path" ]]; then
  echo "artifact must contain manifest.json and ready.json" >&2
  exit 1
fi

jq -e --arg commit_sha "$expected_commit_sha" '
  .version == 1 and
  .commitSha == $commit_sha and
  (.manifestSha256 | type == "string" and test("^[0-9a-f]{64}$"))
' "$ready_path" >/dev/null

expected_manifest_sha="$(jq -r '.manifestSha256' "$ready_path")"
actual_manifest_sha="$(sha256sum "$manifest_path" | cut -d ' ' -f 1)"
if [[ "$actual_manifest_sha" != "$expected_manifest_sha" ]]; then
  echo "artifact manifest digest does not match ready.json" >&2
  exit 1
fi

jq -e --arg commit_sha "$expected_commit_sha" '
  .version == 1 and
  .commitSha == $commit_sha and
  (.files | type == "array" and length > 0) and
  all(
    .files[];
    (.path | type == "string" and length > 0) and
    (.sha256 | type == "string" and test("^[0-9a-f]{64}$")) and
    (.size | type == "number" and . >= 0 and floor == .)
  )
' "$manifest_path" >/dev/null

jq -r '.files[] | [.path, .sha256, (.size | tostring)] | @tsv' "$manifest_path" |
  while IFS=$'\t' read -r relative_path expected_digest expected_size; do
    if [[ "$relative_path" == /* ||
          "$relative_path" == ".." ||
          "$relative_path" == ../* ||
          "$relative_path" == */../* ||
          "$relative_path" == */.. ]]; then
      echo "artifact manifest contains an invalid path: $relative_path" >&2
      exit 1
    fi

    file_path="${artifact_dir}/${relative_path}"
    if [[ ! -f "$file_path" ]]; then
      echo "artifact file is missing: $relative_path" >&2
      exit 1
    fi

    actual_digest="$(sha256sum "$file_path" | cut -d ' ' -f 1)"
    actual_size="$(stat -c '%s' "$file_path")"
    if [[ "$actual_digest" != "$expected_digest" || "$actual_size" != "$expected_size" ]]; then
      echo "artifact file does not match manifest: $relative_path" >&2
      exit 1
    fi
  done

echo "okou app artifact verified for ${expected_commit_sha}"
