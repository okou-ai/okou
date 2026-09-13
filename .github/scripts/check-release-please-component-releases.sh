#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "release presence check: $1" >&2
  exit 1
}

if [ "$#" -ne 3 ]; then
  fail "usage: check-release-please-component-releases.sh <merge-group-base> <merge-group-head> <release-pr-head>"
fi

merge_group_base=$1
merge_group_head=$2
release_pr_head=$3

repo_root=$(git rev-parse --show-toplevel 2>/dev/null) ||
  fail "current directory is not inside a Git repository"
cd "$repo_root"

resolve_commit() {
  local revision=$1 label=$2
  git rev-parse --verify "${revision}^{commit}" 2>/dev/null ||
    fail "${label} is not an available commit: ${revision}"
}

merge_group_base=$(resolve_commit "$merge_group_base" "merge-group base")
merge_group_head=$(resolve_commit "$merge_group_head" "merge-group head")
release_pr_head=$(resolve_commit "$release_pr_head" "release PR head")

mapfile -t merge_group_commit < <(
  git rev-list --parents --max-count=1 "$merge_group_head"
)
read -r -a merge_group_commit <<<"${merge_group_commit[0]}"
if [ "${#merge_group_commit[@]}" -ne 2 ]; then
  fail "merge-group head must have exactly one parent"
fi
if [ "${merge_group_commit[1]}" != "$merge_group_base" ]; then
  fail "merge-group base is not the direct parent of merge-group head"
fi

mapfile -t release_commit < <(
  git rev-list --parents --max-count=1 "$release_pr_head"
)
read -r -a release_commit <<<"${release_commit[0]}"
if [ "${#release_commit[@]}" -ne 2 ]; then
  fail "release PR head must have exactly one parent"
fi
generation_base=${release_commit[1]}

git merge-base --is-ancestor "$generation_base" "$merge_group_base" ||
  fail "release PR generation base is not an ancestor of merge-group base"

read_git_json() {
  local revision=$1 path=$2 label=$3
  local content

  content=$(git show "${revision}:${path}" 2>/dev/null) ||
    fail "missing ${label} at ${revision}: ${path}"
  jq -ceS . <<<"$content" 2>/dev/null ||
    fail "invalid ${label} at ${revision}: ${path}"
}

release_config=$(
  read_git_json \
    "$merge_group_base" \
    "release-please-config.json" \
    "Release Please config"
)
generation_manifest=$(
  read_git_json \
    "$generation_base" \
    ".release-please-manifest.json" \
    "generation manifest"
)
release_manifest=$(
  read_git_json \
    "$release_pr_head" \
    ".release-please-manifest.json" \
    "release PR manifest"
)
merge_group_manifest=$(
  read_git_json \
    "$merge_group_head" \
    ".release-please-manifest.json" \
    "merge-group manifest"
)

if [ "$release_manifest" != "$merge_group_manifest" ]; then
  fail "release PR manifest does not match merge-group head"
fi

components_json=$(jq -ce '
  .packages
  | select(type == "object")
  | to_entries
  | map({path: .key, release_type: .value["release-type"]})
  | select(length > 0)
' <<<"$release_config" 2>/dev/null) ||
  fail "Release Please config must contain a non-empty packages object"
mapfile -t components < <(jq -r '.[].path' <<<"$components_json")

declare -A component_release_types=()
declare -A changed_components=()
changed_component_paths=()
for component in "${components[@]}"; do
  if [[ ! "$component" =~ ^[A-Za-z0-9._/-]+$ ]] ||
    [[ "$component" == /* || "$component" == */ ||
      "/$component/" == *"/../"* || "/$component/" == *"/./"* ||
      "/$component/" == *"//"* ]]; then
    fail "unsafe component path in Release Please config: ${component}"
  fi

  release_type=$(jq -er --arg component "$component" '
    .[]
    | select(.path == $component)
    | .release_type
    | select(type == "string" and length > 0)
  ' <<<"$components_json" 2>/dev/null) ||
    fail "Release Please config is missing a release type for ${component}"
  component_release_types["$component"]=$release_type

  pathspecs=(":(top,glob)${component}/**/src/**")
  if [ "$release_type" = "node" ]; then
    # Match only colocated JS/TS test modules from turbo/vitest.config.ts and
    # Platform's tsconfig.production.json. Helpers, fixtures and other assets
    # remain source; their names or extensions alone do not prove test-only use.
    pathspecs+=(
      ":(top,glob,exclude)${component}/**/src/**/__tests__/**/*.test.[jt]s"
      ":(top,glob,exclude)${component}/**/src/**/__tests__/**/*.test.[jt]sx"
    )
  fi
  # Compare renames as deletion/addition so either production side is retained.
  if git diff --quiet --no-renames "$generation_base" "$merge_group_base" -- "${pathspecs[@]}"; then
    continue
  else
    diff_status=$?
    if [ "$diff_status" -ne 1 ]; then
      fail "could not compare source changes for ${component}"
    fi
  fi

  changed_components["$component"]=true
  changed_component_paths+=("$component")
done

if [ "${#changed_component_paths[@]}" -eq 0 ]; then
  echo "release presence check: no intervening managed source changes"
  echo "release presence check: all intervening managed source changes are covered by release targets"
  exit 0
fi

checkout_head=$(resolve_commit HEAD "checked-out HEAD")
if [ "$checkout_head" != "$merge_group_head" ]; then
  fail "checked-out HEAD does not match merge-group head"
fi

node_component_count=0
rust_component_count=0
for component in "${components[@]}"; do
  case "${component_release_types[$component]}" in
  node) ((node_component_count += 1)) ;;
  rust) ((rust_component_count += 1)) ;;
  *)
    fail "unsupported release type for dependency graph: ${component} (${component_release_types[$component]})"
    ;;
  esac
done

include_node_peer_dependencies=false
if [ "$node_component_count" -ne 0 ]; then
  node_workspace_plugin=$(jq -ce '
    [.plugins[]? | select(.type == "node-workspace")]
    | select(length == 1)
    | .[0]
  ' <<<"$release_config" 2>/dev/null) ||
    fail "Release Please config must enable one node-workspace dependency propagation plugin"
  include_node_peer_dependencies=$(jq -r \
    '.updatePeerDependencies == true' <<<"$node_workspace_plugin")
fi

cargo_workspace_path=""
if [ "$rust_component_count" -ne 0 ]; then
  cargo_workspace_plugin=$(jq -ce '
    [.plugins[]? | select(.type == "cargo-workspace")]
    | select(length == 1)
    | .[0]
  ' <<<"$release_config" 2>/dev/null) ||
    fail "Release Please config must enable one cargo-workspace dependency propagation plugin"
  cargo_workspace_path=$(jq -er '
    (.cargoWorkspacePath // "")
    | select(type == "string")
  ' <<<"$cargo_workspace_plugin" 2>/dev/null) ||
    fail "Release Please cargo-workspace plugin has an invalid workspace path"
  cargo_workspace_path=${cargo_workspace_path#./}
  while [[ "$cargo_workspace_path" == */ ]]; do
    cargo_workspace_path=${cargo_workspace_path%/}
  done
  if [ -n "$cargo_workspace_path" ] &&
    { [[ ! "$cargo_workspace_path" =~ ^[A-Za-z0-9._/-]+$ ]] ||
      [[ "$cargo_workspace_path" == /* ||
        "/$cargo_workspace_path/" == *"/../"* ||
        "/$cargo_workspace_path/" == *"//"* ||
        "/$cargo_workspace_path/" == *"/./"* ]]; }; then
    fail "unsafe Cargo workspace path in Release Please config: ${cargo_workspace_path}"
  fi
fi

declare -A component_dependencies=()
declare -A component_in_degree=()
for component in "${components[@]}"; do
  component_in_degree["$component"]=0
done

add_dependency() {
  local dependent=$1 dependency=$2 existing_dependencies

  existing_dependencies=" ${component_dependencies[$dependent]-} "
  if [[ "$existing_dependencies" == *" ${dependency} "* ]]; then
    return
  fi

  component_dependencies["$dependent"]="${component_dependencies[$dependent]-} ${dependency}"
  component_in_degree["$dependency"]=$((component_in_degree["$dependency"] + 1))
}

declare -A node_components_by_name=()
declare -A node_package_json=()
for component in "${components[@]}"; do
  if [ "${component_release_types[$component]}" != "node" ]; then
    continue
  fi

  package_json=$(
    read_git_json \
      "$merge_group_head" \
      "${component}/package.json" \
      "Node package manifest for ${component}"
  )
  package_name=$(jq -er '.name | select(type == "string" and length > 0)' \
    <<<"$package_json" 2>/dev/null) ||
    fail "Node package manifest is missing a name for ${component}"
  if [ -n "${node_components_by_name[$package_name]+present}" ]; then
    fail "duplicate configured Node package name: ${package_name}"
  fi

  node_components_by_name["$package_name"]=$component
  node_package_json["$component"]=$package_json
done

for component in "${components[@]}"; do
  if [ "${component_release_types[$component]}" != "node" ]; then
    continue
  fi

  dependency_names_json=$(jq -ce \
    --argjson include_peer_dependencies "$include_node_peer_dependencies" '
    [
      (.dependencies // {}),
      (.devDependencies // {}),
      (
        if $include_peer_dependencies
        then (.peerDependencies // {})
        else {}
        end
      ),
      (.optionalDependencies // {})
    ]
    | select(all(.[]; type == "object"))
    | add
    | keys
  ' <<<"${node_package_json[$component]}" 2>/dev/null) ||
    fail "invalid Node dependencies for ${component}"
  mapfile -t dependency_names < <(jq -r '.[]' <<<"$dependency_names_json")
  for dependency_name in "${dependency_names[@]}"; do
    dependency=${node_components_by_name[$dependency_name]-}
    if [ -n "$dependency" ]; then
      add_dependency "$component" "$dependency"
    fi
  done
done

if [ "$rust_component_count" -ne 0 ]; then
  command -v cargo >/dev/null || fail "cargo is required for Cargo workspace metadata"
  cargo_workspace_manifest="${repo_root}/Cargo.toml"
  if [ -n "$cargo_workspace_path" ]; then
    cargo_workspace_manifest="${repo_root}/${cargo_workspace_path}/Cargo.toml"
  fi
  cargo_metadata=$(
    cargo metadata \
      --locked \
      --no-deps \
      --format-version 1 \
      --manifest-path "$cargo_workspace_manifest"
  ) || fail "could not read Cargo workspace metadata"
  cargo_packages=$(jq -ce --arg repo_prefix "${repo_root}/" '
    [
      .packages[]
      | select(.manifest_path | startswith($repo_prefix))
      | {
          path: (
            .manifest_path
            | ltrimstr($repo_prefix)
            | rtrimstr("/Cargo.toml")
          ),
          name,
          dependencies: [
            .dependencies[]
            | (.rename // .name)
          ]
        }
    ]
  ' <<<"$cargo_metadata" 2>/dev/null) ||
    fail "invalid Cargo workspace metadata"

  declare -A rust_components_by_name=()
  declare -A rust_package_json=()
  for component in "${components[@]}"; do
    if [ "${component_release_types[$component]}" != "rust" ]; then
      continue
    fi

    package_json=$(jq -ce --arg component "$component" '
      [.[] | select(.path == $component)]
      | select(length == 1)
      | .[0]
    ' <<<"$cargo_packages" 2>/dev/null) ||
      fail "configured Cargo component is missing from workspace metadata: ${component}"
    package_name=$(jq -r '.name' <<<"$package_json")
    if [ -n "${rust_components_by_name[$package_name]+present}" ]; then
      fail "duplicate configured Cargo package name: ${package_name}"
    fi

    rust_components_by_name["$package_name"]=$component
    rust_package_json["$component"]=$package_json
  done

  for component in "${components[@]}"; do
    if [ "${component_release_types[$component]}" != "rust" ]; then
      continue
    fi

    mapfile -t dependency_names < <(
      jq -r '.dependencies | unique[]' <<<"${rust_package_json[$component]}"
    )
    for dependency_name in "${dependency_names[@]}"; do
      dependency=${rust_components_by_name[$dependency_name]-}
      if [ -n "$dependency" ]; then
        add_dependency "$component" "$dependency"
      fi
    done
  done
fi

release_targets=()
declare -A remaining_in_degree=()
for component in "${components[@]}"; do
  remaining_in_degree["$component"]=${component_in_degree[$component]}
  if [ "${component_in_degree[$component]}" -eq 0 ]; then
    release_targets+=("$component")
  fi
done

if [ "${#release_targets[@]}" -eq 0 ]; then
  fail "release dependency graph has no target roots"
fi

graph_queue=("${release_targets[@]}")
graph_index=0
while [ "$graph_index" -lt "${#graph_queue[@]}" ]; do
  component=${graph_queue[$graph_index]}
  ((graph_index += 1))

  dependencies=()
  if [ -n "${component_dependencies[$component]-}" ]; then
    read -r -a dependencies <<<"${component_dependencies[$component]}"
  fi
  for dependency in "${dependencies[@]}"; do
    remaining_in_degree["$dependency"]=$((remaining_in_degree["$dependency"] - 1))
    if [ "${remaining_in_degree[$dependency]}" -eq 0 ]; then
      graph_queue+=("$dependency")
    fi
  done
done

cyclic_components=()
for component in "${components[@]}"; do
  if [ "${remaining_in_degree[$component]}" -ne 0 ]; then
    cyclic_components+=("$component")
  fi
done
if [ "${#cyclic_components[@]}" -ne 0 ]; then
  printf -v cyclic_list '%s,' "${cyclic_components[@]}"
  cyclic_list=${cyclic_list%,}
  fail "release dependency graph contains a cycle: ${cyclic_list}"
fi

missing_releases=()
declare -A missing_release_changes=()
for target in "${release_targets[@]}"; do
  declare -A closure_seen=()
  closure_queue=("$target")
  closure_index=0
  affected_changes=()
  while [ "$closure_index" -lt "${#closure_queue[@]}" ]; do
    component=${closure_queue[$closure_index]}
    ((closure_index += 1))
    if [ -n "${closure_seen[$component]+present}" ]; then
      continue
    fi
    closure_seen["$component"]=true

    if [ -n "${changed_components[$component]+present}" ]; then
      affected_changes+=("$component")
    fi

    dependencies=()
    if [ -n "${component_dependencies[$component]-}" ]; then
      read -r -a dependencies <<<"${component_dependencies[$component]}"
    fi
    closure_queue+=("${dependencies[@]}")
  done

  if [ "${#affected_changes[@]}" -eq 0 ]; then
    continue
  fi

  generation_version=$(jq -er --arg target "$target" '
    .[$target]
    | select(type == "string" and length > 0)
  ' <<<"$generation_manifest" 2>/dev/null) ||
    fail "generation manifest is missing a version for ${target}"
  release_version=$(jq -er --arg target "$target" '
    .[$target]
    | select(type == "string" and length > 0)
  ' <<<"$release_manifest" 2>/dev/null) ||
    fail "release PR manifest is missing a version for ${target}"

  printf -v affected_list '%s,' "${affected_changes[@]}"
  affected_list=${affected_list%,}

  if [ "$generation_version" = "$release_version" ]; then
    missing_releases+=("$target")
    missing_release_changes["$target"]=$affected_list
  else
    echo "release presence check: ${target} covers ${affected_list} and release advances ${generation_version} -> ${release_version}"
  fi
done

if [ "${#missing_releases[@]}" -ne 0 ]; then
  for target in "${missing_releases[@]}"; do
    echo "::error title=Missing release target::${target} has intervening source changes in ${missing_release_changes[$target]} but no new release" >&2
  done
  fail "${#missing_releases[@]} release target(s) missing"
fi

echo "release presence check: all intervening managed source changes are covered by release targets"
