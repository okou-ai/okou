#!/usr/bin/env bash

runner_image_supported_targets_text() {
  printf '%s\n' "aarch64-unknown-linux-musl, x86_64-unknown-linux-musl"
}

runner_image_supported_uname_m_text() {
  printf '%s\n' "aarch64, x86_64"
}

runner_image_validate_target() {
  local target="${1:-}"
  if [ -z "$target" ]; then
    echo "missing runner image target" >&2
    return 2
  fi

  case "$target" in
    aarch64-unknown-linux-musl|x86_64-unknown-linux-musl)
      return 0
      ;;
    *)
      echo "unsupported runner image target: ${target} (expected one of: $(runner_image_supported_targets_text))" >&2
      return 2
      ;;
  esac
}

runner_image_target_for_uname_m() {
  local uname_m="${1:-}"
  if [ -z "$uname_m" ]; then
    echo "missing runner host architecture" >&2
    return 2
  fi

  case "$uname_m" in
    aarch64)
      printf '%s\n' "aarch64-unknown-linux-musl"
      ;;
    x86_64)
      printf '%s\n' "x86_64-unknown-linux-musl"
      ;;
    *)
      echo "unsupported runner host architecture: ${uname_m} (expected one of: $(runner_image_supported_uname_m_text))" >&2
      return 2
      ;;
  esac
}

runner_image_artifact_name() {
  local target="${1:-}"
  local head_sha="${2:-}"
  local job_ref="${3:-}"

  runner_image_validate_target "$target" || return $?
  printf 'runner-image-manifest-%s-%s-%s\n' "$target" "$head_sha" "$job_ref"
}

runner_image_expected_uname_m() {
  local target="${1:-}"

  runner_image_validate_target "$target" || return $?
  case "$target" in
    aarch64-unknown-linux-musl)
      printf '%s\n' "aarch64"
      ;;
    x86_64-unknown-linux-musl)
      printf '%s\n' "x86_64"
      ;;
    *)
      echo "missing runner image uname metadata for target: ${target}" >&2
      return 2
      ;;
  esac
}

runner_image_cache_suffix() {
  local target="${1:-}"

  runner_image_validate_target "$target" || return $?
  case "$target" in
    aarch64-unknown-linux-musl)
      printf '%s\n' "aarch64-musl"
      ;;
    x86_64-unknown-linux-musl)
      printf '%s\n' "x86_64-musl"
      ;;
    *)
      echo "missing runner image cache suffix metadata for target: ${target}" >&2
      return 2
      ;;
  esac
}

runner_image_sccache_architecture() {
  local target="${1:-}"

  runner_image_validate_target "$target" || return $?
  case "$target" in
    aarch64-unknown-linux-musl)
      printf '%s\n' "arm64"
      ;;
    x86_64-unknown-linux-musl)
      printf '%s\n' "x86_64"
      ;;
    *)
      echo "missing runner image sccache architecture for target: ${target}" >&2
      return 2
      ;;
  esac
}

runner_image_asset_suffix() {
  local target="${1:-}"

  runner_image_validate_target "$target" || return $?
  case "$target" in
    aarch64-unknown-linux-musl)
      printf '%s\n' "aarch64-linux"
      ;;
    x86_64-unknown-linux-musl)
      printf '%s\n' "x86_64-linux"
      ;;
    *)
      echo "missing runner image asset suffix metadata for target: ${target}" >&2
      return 2
      ;;
  esac
}

runner_image_release_tag() {
  local version="${1:-}"
  if [ -z "$version" ]; then
    echo "missing runner release version" >&2
    return 2
  fi
  if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "unsupported runner release version: ${version} (expected semver like 0.81.0, without leading v)" >&2
    return 2
  fi

  printf 'runner-rs-v%s\n' "$version"
}

runner_image_release_asset_name() {
  local version="${1:-}"
  local target="${2:-}"
  local asset_suffix

  runner_image_release_tag "$version" >/dev/null || return $?
  asset_suffix=$(runner_image_asset_suffix "$target") || return $?
  printf 'runner-v%s-%s\n' "$version" "$asset_suffix"
}

runner_image_elf_machine_hex() {
  local target="${1:-}"

  runner_image_validate_target "$target" || return $?
  case "$target" in
    aarch64-unknown-linux-musl)
      printf '%s\n' "b700"
      ;;
    x86_64-unknown-linux-musl)
      printf '%s\n' "3e00"
      ;;
    *)
      echo "missing runner image ELF machine metadata for target: ${target}" >&2
      return 2
      ;;
  esac
}
