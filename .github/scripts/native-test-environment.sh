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
  native_build_command=(setpriv --reuid "$native_uid" --regid "$native_gid" --clear-groups
    --bounding-set=-all --no-new-privs env
    HOME="$target/native-ci-home" CARGO_HOME="$target/native-ci-cargo"
    GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0="$PWD")
  native_privileged_command=()
fi
native_build() {
  "${native_build_command[@]}" "$@"
}
native_privileged() {
  "${native_privileged_command[@]}" "$@"
}
