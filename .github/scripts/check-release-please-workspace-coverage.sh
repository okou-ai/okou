#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "release please workspace coverage: $1" >&2
  exit 1
}

for required_command in cargo jq realpath sort yq; do
  command -v "$required_command" >/dev/null ||
    fail "${required_command} is required"
done

repo_root=$(git rev-parse --show-toplevel 2>/dev/null) ||
  fail "current directory is not inside a Git repository"
cd "$repo_root"

release_config_path="${repo_root}/release-please-config.json"
release_manifest_path="${repo_root}/.release-please-manifest.json"
exclusions_path="${repo_root}/.github/release-please-workspace-exclusions.json"
node_workspace_path="${repo_root}/turbo/pnpm-workspace.yaml"

release_config=$(jq -ce '
  select(
    type == "object" and
    (.packages | type == "object" and length > 0) and
    (.packages | all(to_entries[]; .value["release-type"] == "node" or .value["release-type"] == "rust" or (.key == "ios" and .value["release-type"] == "simple")))
  )
' "$release_config_path" 2>/dev/null) ||
  fail "Release Please config must contain Node, Rust, or the standalone iOS package entries"
release_manifest=$(jq -ce '
  select(type == "object" and all(to_entries[]; .value | type == "string" and length > 0))
' "$release_manifest_path" 2>/dev/null) ||
  fail "Release Please manifest must map package paths to versions"
exclusions=$(jq -ce '
  select(
    type == "object" and
    all(to_entries[]; .value | type == "string" and test("[^[:space:]]"))
  )
' "$exclusions_path" 2>/dev/null) ||
  fail "workspace exclusions must map package paths to non-empty reasons"
node_workspace=$(yq -o=json '.' "$node_workspace_path" 2>/dev/null | jq -ce '
  select(
    type == "object" and
    (.packages | type == "array" and length > 0) and
    (.packages | all(.[]; type == "string" and length > 0))
  )
' 2>/dev/null) ||
  fail "pnpm workspace must contain non-empty package patterns"
work_dir=$(mktemp -d)
trap 'rm -rf "$work_dir"' EXIT

managed_node_paths="${work_dir}/managed-node"
managed_rust_paths="${work_dir}/managed-rust"
managed_paths="${work_dir}/managed"
manifest_paths="${work_dir}/manifest"
excluded_paths="${work_dir}/excluded"
node_workspace_paths="${work_dir}/node-workspace"
rust_workspace_paths="${work_dir}/rust-workspace"
workspace_paths="${work_dir}/workspace"
classified_paths="${work_dir}/classified"
difference_paths="${work_dir}/difference"

jq -r '
  .packages
  | to_entries[]
  | select(.value["release-type"] == "node")
  | .key
' <<<"$release_config" | sort -u >"$managed_node_paths"
jq -r '
  .packages
  | to_entries[]
  | select(.value["release-type"] == "rust")
  | .key
' <<<"$release_config" | sort -u >"$managed_rust_paths"
jq -r '.packages | keys[]' <<<"$release_config" | sort -u >"$managed_paths"
jq -r 'keys[]' <<<"$release_manifest" | sort -u >"$manifest_paths"
jq -r 'keys[]' <<<"$exclusions" | sort -u >"$excluded_paths"

comm -23 "$managed_paths" "$manifest_paths" >"$difference_paths"
if [ -s "$difference_paths" ]; then
  fail "Release Please manifest is missing configured packages: $(paste -sd, "$difference_paths")"
fi
comm -13 "$managed_paths" "$manifest_paths" >"$difference_paths"
if [ -s "$difference_paths" ]; then
  fail "Release Please manifest contains unconfigured packages: $(paste -sd, "$difference_paths")"
fi

# iOS is a standalone Xcode project, not a pnpm or Cargo workspace member.
if jq -e '.packages | has("ios")' <<<"$release_config" >/dev/null; then
  ios_version=$(cat ios/version.txt) || fail "missing iOS version file"
  ios_config_version=$(sed -n 's/^MARKETING_VERSION = \([^ ]*\).*/\1/p' ios/Config/Shared.xcconfig)
  ios_manifest_version=$(jq -r '.ios' <<<"$release_manifest")
  if [ "$ios_version" != "$ios_manifest_version" ] || [ "$ios_version" != "$ios_config_version" ]; then
    fail "iOS manifest, version.txt, and MARKETING_VERSION must agree"
  fi
fi

node_workspace_root=$(dirname "$node_workspace_path")
declare -A node_packages=()
mapfile -t node_patterns < <(jq -r '.packages[]' <<<"$node_workspace")
shopt -s globstar
for raw_pattern in "${node_patterns[@]}"; do
  pattern=$raw_pattern
  excluded_pattern=false
  if [[ "$pattern" == "!"* ]]; then
    excluded_pattern=true
    pattern=${pattern#!}
  fi
  if [ -z "$pattern" ] || [[ "$pattern" == /* ]] ||
    [[ "/$pattern/" == *"/../"* ]] || [[ "/$pattern/" == *"//"* ]]; then
    fail "unsafe pnpm workspace pattern: ${raw_pattern}"
  fi

  mapfile -t package_manifests < <(
    compgen -G "${node_workspace_root}/${pattern}/package.json" || true
  )
  for package_manifest in "${package_manifests[@]}"; do
    package_directory=$(realpath "$(dirname "$package_manifest")")
    package_relative_path=$(realpath --relative-to="$repo_root" "$package_directory")
    if [[ "$package_relative_path" == ".." || "$package_relative_path" == "../"* ]]; then
      fail "pnpm workspace package escapes the repository: ${package_manifest}"
    fi
    if [ "$excluded_pattern" = true ]; then
      unset 'node_packages[$package_relative_path]'
    else
      node_packages["$package_relative_path"]=true
    fi
  done
done
for package_relative_path in "${!node_packages[@]}"; do
  printf '%s\n' "$package_relative_path"
done | sort -u >"$node_workspace_paths"

cargo_workspace_plugin=$(jq -ce '
  [.plugins[]? | select(.type == "cargo-workspace")]
  | select(length == 1)
  | .[0]
' <<<"$release_config" 2>/dev/null) ||
  fail "Release Please config must enable one Cargo workspace plugin"
cargo_workspace_relative_path=$(jq -er '
  (.cargoWorkspacePath // "")
  | select(type == "string")
' <<<"$cargo_workspace_plugin" 2>/dev/null) ||
  fail "Release Please Cargo workspace path must be a string"
cargo_workspace_relative_path=${cargo_workspace_relative_path#./}
while [[ "$cargo_workspace_relative_path" == */ ]]; do
  cargo_workspace_relative_path=${cargo_workspace_relative_path%/}
done
if [[ "$cargo_workspace_relative_path" == /* ]] ||
  [[ "/$cargo_workspace_relative_path/" == *"/../"* ]] ||
  { [ -n "$cargo_workspace_relative_path" ] &&
    [[ "/$cargo_workspace_relative_path/" == *"//"* ]]; }; then
  fail "unsafe Cargo workspace path: ${cargo_workspace_relative_path}"
fi
cargo_workspace_manifest="${repo_root}/Cargo.toml"
if [ -n "$cargo_workspace_relative_path" ]; then
  cargo_workspace_manifest="${repo_root}/${cargo_workspace_relative_path}/Cargo.toml"
fi
cargo_metadata=$(cargo metadata \
  --locked \
  --no-deps \
  --format-version 1 \
  --manifest-path "$cargo_workspace_manifest") ||
  fail "could not read Cargo workspace metadata"
jq -r --arg repo_prefix "${repo_root}/" '
  .workspace_members as $workspace_members
  | .packages[]
  | select(.id as $id | $workspace_members | index($id))
  | .manifest_path
  | select(startswith($repo_prefix))
  | ltrimstr($repo_prefix)
  | sub("/Cargo.toml$"; "")
' <<<"$cargo_metadata" | sort -u >"$rust_workspace_paths"

comm -23 "$managed_node_paths" "$node_workspace_paths" >"$difference_paths"
if [ -s "$difference_paths" ]; then
  fail "configured Node packages are not pnpm workspace packages: $(paste -sd, "$difference_paths")"
fi
comm -23 "$managed_rust_paths" "$rust_workspace_paths" >"$difference_paths"
if [ -s "$difference_paths" ]; then
  fail "configured Rust packages are not Cargo workspace crates: $(paste -sd, "$difference_paths")"
fi

sort -u "$node_workspace_paths" "$rust_workspace_paths" >"$workspace_paths"
comm -12 "$managed_paths" "$excluded_paths" >"$difference_paths"
if [ -s "$difference_paths" ]; then
  fail "workspace packages cannot be both managed and excluded: $(paste -sd, "$difference_paths")"
fi
comm -23 "$excluded_paths" "$workspace_paths" >"$difference_paths"
if [ -s "$difference_paths" ]; then
  fail "workspace exclusions reference non-workspace packages: $(paste -sd, "$difference_paths")"
fi

sort -u "$managed_paths" "$excluded_paths" >"$classified_paths"
comm -23 "$workspace_paths" "$classified_paths" >"$difference_paths"
if [ -s "$difference_paths" ]; then
  fail "unclassified workspace packages: $(paste -sd, "$difference_paths")"
fi

node_count=$(wc -l <"$node_workspace_paths")
rust_count=$(wc -l <"$rust_workspace_paths")
excluded_count=$(wc -l <"$excluded_paths")
node_count=${node_count//[[:space:]]/}
rust_count=${rust_count//[[:space:]]/}
excluded_count=${excluded_count//[[:space:]]/}
echo "release please workspace coverage: ok (${node_count} Node, ${rust_count} Rust, ${excluded_count} excluded)"
