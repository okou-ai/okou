set -eu

refuse_workspace_symlink_path() {
  check_path=
  remaining=${workspace_dir#/}
  while [ -n "$remaining" ]; do
    component=${remaining%%/*}
    if [ "$remaining" = "$component" ]; then
      remaining=
    else
      remaining=${remaining#*/}
    fi
    check_path="$check_path/$component"
    if [ -L "$check_path" ]; then
      echo "refusing to use symlink workspace path component: $check_path" >&2
      exit 64
    fi
  done
}

refuse_workspace_symlink_path
workspace_dev="$(mountpoint -x -- "$workspace_device" 2>/dev/null || true)"
if ! mountpoint -q -- "$workspace_dir"; then
  echo "workspace drive is not mounted: $workspace_dir" >&2
  exit 65
fi

# Pin the directory before validating its filesystem identity. Freezing through
# this descriptor closes the path-replacement race between validation and the
# FIFREEZE ioctl.
exec 3< "$workspace_dir"
workspace_fd_path="/proc/$$/fd/3"
target_dev="$(mountpoint -d -- "$workspace_fd_path" 2>/dev/null || true)"
if [ -z "$workspace_dev" ] || [ "$target_dev" != "$workspace_dev" ]; then
  echo "refusing to freeze non-workspace mountpoint: $workspace_dir" >&2
  exit 64
fi

"$workspace_fsfreeze_path" --freeze "$workspace_fd_path"
