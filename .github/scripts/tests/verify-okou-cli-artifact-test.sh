#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
verify_script="${repo_root}/.github/scripts/verify-okou-cli-artifact.sh"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

commit_sha="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
cli_version="9.353.0"
versions_json="$(jq -nc \
  --arg cli "$cli_version" \
  '{cli: $cli, piAgentRuntime: "1.36.0", piSdk: "0.86.1+okou.0123456789ab"}')"
session_construction_json="$(jq -nc '{digest: ("d" * 64)}')"

# create_artifact <dir> <include_worker> <include_wasm> [package_version] [versions] [session_construction]
# `versions` is the manifest `versions` object and `session_construction` the
# manifest `sessionConstruction` object; pass `null` to omit either.
create_artifact() {
  local artifact_dir="$1"
  local include_worker="$2"
  local include_wasm="$3"
  local package_version="${4:-$cli_version}"
  local versions="${5:-$versions_json}"
  local session_construction="${6:-$session_construction_json}"
  local package_root="${artifact_dir}/contents/package"

  mkdir -p "$package_root"
  jq -n \
    --arg version "$package_version" \
    '{
      name: "@okouai/cli",
      version: $version,
      private: true,
      bin: {okou: "okou.js"}
    }' >"${package_root}/package.json"
  printf 'okou\n' >"${package_root}/okou.js"
  if [[ "$include_worker" == "true" ]]; then
    printf 'worker\n' >"${package_root}/image-resize-worker.js"
  fi
  if [[ "$include_wasm" == "true" ]]; then
    printf 'wasm\n' >"${package_root}/photon_rs_bg.wasm"
  fi

  tar -czf "${artifact_dir}/package.tgz" \
    -C "${artifact_dir}/contents" package
  local package_sha256
  package_sha256="$(sha256sum "${artifact_dir}/package.tgz" | cut -d ' ' -f 1)"
  local package_size
  package_size="$(wc -c <"${artifact_dir}/package.tgz" | tr -d '[:space:]')"
  jq -n \
    --arg commit_sha "$commit_sha" \
    --arg package_sha256 "$package_sha256" \
    --argjson package_size "$package_size" \
    --argjson versions "$versions" \
    --argjson session_construction "$session_construction" \
    '{
      version: 1,
      commitSha: $commit_sha,
      package: {
        path: "package.tgz",
        sha256: $package_sha256,
        size: $package_size
      }
    }
    + (if $versions == null then {} else {versions: $versions} end)
    + (if $session_construction == null then {}
       else {sessionConstruction: $session_construction} end)' \
    >"${artifact_dir}/manifest.json"
  local manifest_sha256
  manifest_sha256="$(sha256sum "${artifact_dir}/manifest.json" | cut -d ' ' -f 1)"
  jq -n \
    --arg commit_sha "$commit_sha" \
    --arg manifest_sha256 "$manifest_sha256" \
    '{version: 1, commitSha: $commit_sha, manifestSha256: $manifest_sha256}' \
    >"${artifact_dir}/ready.json"
}

# reject_artifact <name> <message> <create_artifact args...>
reject_artifact() {
  local name="$1"
  local message="$2"
  shift 2
  local artifact_dir="${tmp_dir}/${name}"
  mkdir -p "$artifact_dir"
  create_artifact "$artifact_dir" "$@"
  if bash "$verify_script" "$artifact_dir" "$commit_sha" \
    >"${tmp_dir}/${name}.txt" 2>&1; then
    echo "$message" >&2
    exit 1
  fi
  printf '%s\n' "${tmp_dir}/${name}.txt"
}

complete_artifact="${tmp_dir}/complete"
mkdir -p "$complete_artifact"
create_artifact "$complete_artifact" true true
bash "$verify_script" "$complete_artifact" "$commit_sha" >/dev/null

missing_worker_output="$(reject_artifact missing-worker \
  "Verifier accepted an artifact without the image resize worker" \
  false true)"
grep -Fq "CLI package is missing image-resize-worker.js" \
  "$missing_worker_output"

missing_wasm_output="$(reject_artifact missing-wasm \
  "Verifier accepted an artifact without the Photon WASM" \
  true false)"
grep -Fq "CLI package is missing photon_rs_bg.wasm" "$missing_wasm_output"

# The rootfs installs the bundle by version, so an artifact that does not
# declare its versions, or whose packed CLI disagrees with them, is unusable.
reject_artifact missing-versions \
  "Verifier accepted a manifest without versions" \
  true true "$cli_version" null >/dev/null

reject_artifact mismatched-cli-version \
  "Verifier accepted a package.json version that differs from the manifest" \
  true true "9.353.1" >/dev/null

reject_artifact invalid-pi-sdk-version \
  "Verifier accepted a Pi SDK version without the patch-set identity" \
  true true "$cli_version" \
  "$(jq -c '.piSdk = "0.86.1"' <<<"$versions_json")" >/dev/null

# The session-construction digest is the parity key the guest compares, so an
# artifact must declare a well-formed one.
reject_artifact missing-session-construction \
  "Verifier accepted a manifest without the session-construction digest" \
  true true "$cli_version" "$versions_json" null >/dev/null

reject_artifact invalid-session-construction \
  "Verifier accepted a session-construction digest that is not 64 lowercase hex" \
  true true "$cli_version" "$versions_json" '{"digest":"nope"}' >/dev/null

echo "verify-okou-cli-artifact tests passed"
