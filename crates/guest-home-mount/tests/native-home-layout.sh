#!/usr/bin/env bash
# Real ext4/visible-mount acceptance against a rebuilt paired rootfs.
# Run as root on a native Linux host: bash native-home-layout.sh ROOTFS.ext4
# This is not KVM/snapshot proof; that remains the controlled Runner pipeline.
set -euo pipefail

if [[ $# -ne 1 || ! -f "$1" ]]; then
  echo "usage: bash native-home-layout.sh ROOTFS.ext4" >&2
  exit 64
fi
if [[ $(id -u) -ne 0 ]]; then
  echo "native ext4 acceptance requires root and mount/loop-device authority" >&2
  exit 1
fi
if [[ "${OKOU_NATIVE_HOME_PRIVATE_NAMESPACE:-}" != 1 ]]; then
  exec unshare --mount --propagation private env OKOU_NATIVE_HOME_PRIVATE_NAMESPACE=1 bash "$0" "$(realpath "$1")"
fi

work=$(mktemp -d)
root_loop=""
home_loop=""
cleanup() {
  local status=$?
  trap - EXIT
  if mountpoint -q "$work/root/proc"; then umount "$work/root/proc" || status=1; fi
  if mountpoint -q "$work/root/home/user"; then umount "$work/root/home/user" || status=1; fi
  if mountpoint -q "$work/root"; then umount "$work/root" || status=1; fi
  if [[ -n "$home_loop" ]]; then losetup -d "$home_loop" || status=1; fi
  if [[ -n "$root_loop" ]]; then losetup -d "$root_loop" || status=1; fi
  # Refuse to cross a mount if cleanup failed. Original input is never mutated.
  rm -rf --one-file-system "$work" || status=1
  exit "$status"
}
trap cleanup EXIT

cp --sparse=always -- "$1" "$work/rootfs.ext4"
truncate -s $((24576 * 1024 * 1024)) "$work/home.ext4"
mkfs.ext4 -F -q "$work/home.ext4"
root_loop=$(losetup --find --show "$work/rootfs.ext4")
home_loop=$(losetup --find --show "$work/home.ext4")
mkdir "$work/root"
mount "$root_loop" "$work/root"
mount -t proc proc "$work/root/proc"
[[ -x "$work/root/sbin/guest-home-mount" ]]
uid=$(chroot "$work/root" id -u user)
gid=$(chroot "$work/root" id -g user)
[[ $uid -ne 0 && $gid -ne 0 ]]
read -r major minor < <(stat -c '%t %T' "$home_loop")
rm -f -- "$work/root/dev/vdb"
mknod "$work/root/dev/vdb" b "$((16#$major))" "$((16#$minor))"

# Fresh initialization exercises the production binary, block-device checks,
# actual post-mount statx/mountinfo, descriptor writes, and account ownership.
chroot "$work/root" /sbin/guest-home-mount
[[ $(findmnt -n -o TARGET --mountpoint "$work/root/home/user") == "$work/root/home/user" ]]
[[ $(stat -c '%u:%g' "$work/root/home/user") == "$uid:$gid" ]]
[[ $(stat -c '%u:%g' "$work/root/home/user/workspace") == "$uid:$gid" ]]
[[ $(chroot "$work/root" sh -c 'cd /home/user/workspace && pwd') == /home/user/workspace ]]
for name in .bashrc .profile .bash_logout; do [[ -f "$work/root/home/user/$name" ]]; done

# A hit and a newly attached persisted home retain ordinary user bytes without
# backfilling defaults, recursively copying the used rootfs home, or chowning
# existing trees. Remount is a real filesystem test, not a snapshot surrogate.
printf 'user shell customization\n' > "$work/root/home/user/.bashrc"
printf 'ordinary home bytes\n' > "$work/root/home/user/ordinary"
printf 'cwd bytes\n' > "$work/root/home/user/workspace/ordinary"
rm -- "$work/root/home/user/.profile"
chroot "$work/root" /sbin/guest-home-mount
umount "$work/root/home/user"
chroot "$work/root" /sbin/guest-home-mount
[[ $(<"$work/root/home/user/.bashrc") == 'user shell customization' ]]
[[ $(<"$work/root/home/user/ordinary") == 'ordinary home bytes' ]]
[[ $(<"$work/root/home/user/workspace/ordinary") == 'cwd bytes' ]]
[[ ! -e "$work/root/home/user/.profile" ]]
[[ $(stat -c '%u:%g' "$work/root/home/user/ordinary") == '0:0' ]]

# Detach before replacing an image, as the snapshot owner does. A second
# pristine image must not expose the first image's cached inode/ordinary bytes.
umount "$work/root/home/user"
losetup -d "$home_loop"
home_loop=""
truncate -s $((24576 * 1024 * 1024)) "$work/replacement.ext4"
mkfs.ext4 -F -q "$work/replacement.ext4"
home_loop=$(losetup --find --show "$work/replacement.ext4")
read -r major minor < <(stat -c '%t %T' "$home_loop")
rm -- "$work/root/dev/vdb"
mknod "$work/root/dev/vdb" b "$((16#$major))" "$((16#$minor))"
chroot "$work/root" /sbin/guest-home-mount
[[ ! -e "$work/root/home/user/ordinary" ]]
[[ ! -e "$work/root/home/user/workspace/ordinary" ]]
[[ -f "$work/root/home/user/.profile" ]]

# Revalidation rejects a different visible mount rather than trusting PID 1.
umount "$work/root/home/user"
mount -t tmpfs tmpfs "$work/root/home/user"
if chroot "$work/root" /sbin/guest-home-mount; then
  echo 'unrelated existing home mount was accepted' >&2
  exit 1
fi
umount "$work/root/home/user"
chroot "$work/root" /sbin/guest-home-mount

# Never traverse a persisted symlink execution cwd.
mv "$work/root/home/user/workspace" "$work/root/home/user/kept-workspace"
ln -s /root "$work/root/home/user/workspace"
if chroot "$work/root" /sbin/guest-home-mount; then
  echo 'symlink execution cwd was accepted' >&2
  exit 1
fi
rm -- "$work/root/home/user/workspace"
mv "$work/root/home/user/kept-workspace" "$work/root/home/user/workspace"
chroot "$work/root" /sbin/guest-home-mount
printf 'native home layout and namespace preservation passed\n'
