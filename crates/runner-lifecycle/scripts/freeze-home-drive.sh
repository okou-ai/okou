set -eu

refuse_home_symlink_path() {
  check_path=
  remaining=${home_dir#/}
  while [ -n "$remaining" ]; do
    component=${remaining%%/*}
    if [ "$remaining" = "$component" ]; then remaining=; else remaining=${remaining#*/}; fi
    check_path="$check_path/$component"
    if [ -L "$check_path" ]; then
      echo "refusing to use symlink home path component: $check_path" >&2
      exit 64
    fi
  done
}

refuse_home_symlink_path
home_dev="$(mountpoint -x -- "$home_device" 2>/dev/null || true)"
if ! mountpoint -q -- "$home_dir"; then
  echo "home drive is not mounted: $home_dir" >&2
  exit 65
fi

# Pin before checking device identity and issue FIFREEZE through that descriptor.
# Once frozen this sandbox may only be terminated and destroyed, never thawed.
exec 3< "$home_dir"
home_fd_path="/proc/$$/fd/3"
target_dev="$(mountpoint -d -- "$home_fd_path" 2>/dev/null || true)"
if [ -z "$home_dev" ] || [ "$target_dev" != "$home_dev" ]; then
  echo "refusing to freeze non-home mountpoint: $home_dir" >&2
  exit 64
fi
"$home_fsfreeze_path" --freeze "$home_fd_path"
