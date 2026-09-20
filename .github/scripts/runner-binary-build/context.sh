#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"

fail() {
  echo "runner binary context: $1" >&2
  exit 1
}

is_safe_git_path() {
  local path=$1
  [[ -n "$path" && "$path" != /* && "$path" != */ ]] || return 1
  case "/${path}/" in
    *"//"*|*"/./"*|*"/../"*) return 1 ;;
  esac
}

is_excluded_path() {
  local path=$1

  # Complete tests directory segments are an audited repository convention
  # outside production build entry points. Test-named files remain included.
  if [[ "$path" == crates/*/tests/* ]]; then
    return 0
  fi
  if [[ "$path" =~ ^crates/[^/]+/(benches|examples)/ ]]; then
    return 0
  fi
  return 1
}

emit_inventory() {
  local repo_root=$1 revision=$2 record metadata path mode type object extra
  local required_path
  local -a tree_entries=()
  local -a required_paths=(
    ".github/scripts/runner-binary-build/build.sh"
    ".github/scripts/runner-binary-build/compile.sh"
    ".github/scripts/runner-binary-build/context.sh"
    ".github/scripts/runner-binary-build/contract.env"
    ".github/scripts/runner-binary-build/digest.sh"
    "crates/Cargo.lock"
    "crates/Cargo.toml"
  )
  local -A found_paths=()

  git -C "$repo_root" rev-parse --verify "${revision}^{commit}" >/dev/null ||
    fail "invalid committed revision: ${revision}"

  mapfile -d '' -t tree_entries < <(
    git -C "$repo_root" ls-tree --full-tree -r -z "$revision" -- \
      .github/scripts/runner-binary-build \
      crates
  )
  for record in "${tree_entries[@]}"; do
    [[ "$record" == *$'\t'* ]] || fail "malformed Git tree entry"
    metadata=${record%%$'\t'*}
    path=${record#*$'\t'}
    extra=""
    IFS=' ' read -r mode type object extra <<<"$metadata"
    [[ -z "$extra" && -n "$mode" && -n "$type" && -n "$object" ]] ||
      fail "malformed Git tree metadata for ${path}"

    if is_excluded_path "$path"; then
      continue
    fi
    is_safe_git_path "$path" || fail "unsafe included path: ${path}"
    [[ "$type" == "blob" ]] || fail "unsupported included Git object ${type}: ${path}"
    case "$mode" in
      100644|100755) ;;
      *) fail "unsupported included Git mode ${mode}: ${path}" ;;
    esac

    found_paths["$path"]=1
    printf '%s\0' "$record"
  done

  for required_path in "${required_paths[@]}"; do
    [[ ${found_paths[$required_path]+present} ]] ||
      fail "required context path is not a tracked regular file: ${required_path}"
  done
}

validate_workspace() {
  local crates_dir="${1}/crates"
  if ! (
    cd "$crates_dir"
    cargo metadata --locked --no-deps --format-version 1 >/dev/null
  ); then
    fail "Cargo cannot load the materialized workspace"
  fi
}

case "${1:-}" in
  inventory)
    repo_root="${2:-$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)}"
    emit_inventory "$repo_root" "${3:-HEAD}"
    ;;
  validate-workspace)
    validate_workspace "${2:-$SOURCE_ROOT}"
    ;;
  *)
    echo "usage: context.sh inventory [repo-root] [revision] | validate-workspace [source-root]" >&2
    exit 2
    ;;
esac
