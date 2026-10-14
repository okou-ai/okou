#!/usr/bin/env bash
# The toolchain container has no sudo. Keep its build owner unprivileged and
# reserve the root caller's namespace capability for synthetic runtime bootstrap.
# Outside that explicitly selected environment, retain the native host caller.
native_build_command=()
native_privileged_command=(sudo)
native_uid=$(id -u)
native_gid=$(id -g)
if [[ -n ${NATIVE_TEST_OWNER:-} ]]; then
  [[ $native_uid == 0 ]] || { echo 'native container bootstrap requires root' >&2; exit 1; }
  native_uid=$(id -u "$NATIVE_TEST_OWNER")
  native_gid=$(id -g "$NATIVE_TEST_OWNER")
  [[ $native_uid != 0 ]] || { echo 'native build owner must be unprivileged' >&2; exit 1; }
  target="$PWD/crates/target"
  for directory in "$target" "$target/native-ci-home" "$target/native-ci-cargo"; do
    [[ ! -L "$directory" && $(realpath -m "$directory") == "$directory" ]] || exit 1
    mkdir -p "$directory"
    chown --no-dereference "$native_uid:$native_gid" "$directory"
  done
  if [[ -n ${KERBEROS_NATIVE_CACHE_DIR:-} ]]; then
    native_cache=$KERBEROS_NATIVE_CACHE_DIR
    [[ -n ${RUNNER_TEMP:-} && $native_cache == "$RUNNER_TEMP/kerberos-native-cache" &&
      ! -L "$native_cache" && $(realpath -m "$native_cache") == "$native_cache" ]] || exit 1
    mkdir -p "$native_cache"
    # Restore runs as root. Refuse links/special files before handing all cache
    # products and lock files to the capability-free compiler owner.
    native_cache_unsafe=$(find "$native_cache" \( ! -type d ! -type f -o -type f -links +1 \) -print -quit) || exit 1
    [[ -z "$native_cache_unsafe" ]] || { echo 'unsafe native dependency cache entry' >&2; exit 1; }
    chown --recursive --no-dereference "$native_uid:$native_gid" "$native_cache"
  fi
  native_build_command=(setpriv --reuid "$native_uid" --regid "$native_gid" --clear-groups
    --bounding-set=-all --no-new-privs env
    HOME="$target/native-ci-home" CARGO_HOME="$target/native-ci-cargo"
    GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0="$PWD")
  native_privileged_command=()
  if [[ -n ${KERBEROS_NATIVE_CACHE_DIR:-} ]]; then
    "${native_build_command[@]}" test -w "$native_cache" || exit 1
  fi
fi
native_build() {
  "${native_build_command[@]}" "$@"
}
native_privileged() {
  "${native_privileged_command[@]}" "$@"
}
