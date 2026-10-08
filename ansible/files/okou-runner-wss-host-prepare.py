#!/usr/bin/python3
"""Prepare the fixed Runner WSS namespace without repairing existing state."""

import fcntl
import grp
import os
import stat
import sys
from contextlib import ExitStack

GROUP = "okou-wss-caddy"
NAMESPACE = "okou-ws"
DIRECTORY_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC


def open_directory(stack, name, parent=None):
    descriptor = os.open(name, DIRECTORY_FLAGS, dir_fd=parent)
    stack.callback(os.close, descriptor)
    return descriptor


def validate_parent(descriptor, path):
    metadata = os.fstat(descriptor)
    if metadata.st_uid != 0 or stat.S_IMODE(metadata.st_mode) & 0o022:
        raise RuntimeError(f"{path} must be root-owned and not group/world-writable")
    if "system.posix_acl_default" in os.listxattr(descriptor):
        raise RuntimeError(f"{path} must not pass default ACLs to the WSS namespace")


def prepare():
    if len(sys.argv) != 1 or os.geteuid() != 0:
        raise RuntimeError("preparation requires root and accepts no arguments")
    try:
        group_id = grp.getgrnam(GROUP).gr_gid
    except KeyError as error:
        raise RuntimeError(f"required system group {GROUP} is missing") from error
    if group_id == 0:
        raise RuntimeError(f"{GROUP} must be distinct from the root group")

    with ExitStack() as stack:
        root = open_directory(stack, "/")
        validate_parent(root, "/")
        runtime = open_directory(stack, "run", root)
        validate_parent(runtime, "/run")
        # Serialize only cooperating preparers. Trusted root writers own /run;
        # Runner processes own child sockets, never this directory's metadata.
        fcntl.flock(runtime, fcntl.LOCK_EX)
        created = False
        try:
            namespace = open_directory(stack, NAMESPACE, runtime)
        except FileNotFoundError:
            try:
                os.mkdir(NAMESPACE, 0o700, dir_fd=runtime)
                created = True
            except FileExistsError:
                # Another trusted writer won creation; validate, never repair.
                pass
            namespace = open_directory(stack, NAMESPACE, runtime)

        if created:
            # Directory FD ownership updates the actual directory inode. This
            # does not implement or fix ownership of a pathname Unix socket.
            os.fchown(namespace, 0, group_id)
            os.fchmod(namespace, 0o710)

        # Numeric mode reports an ACL mask, not every named user's access.
        # Default ACLs could also silently grant access to future sockets.
        if {"system.posix_acl_access", "system.posix_acl_default"}.intersection(
            os.listxattr(namespace)
        ):
            raise RuntimeError(f"/run/{NAMESPACE} must not have POSIX ACLs")
        metadata = os.fstat(namespace)
        pathname = os.stat(NAMESPACE, dir_fd=runtime, follow_symlinks=False)
        if (
            metadata.st_uid != 0
            or metadata.st_gid != group_id
            or stat.S_IMODE(metadata.st_mode) != 0o710
            or (metadata.st_dev, metadata.st_ino) != (pathname.st_dev, pathname.st_ino)
        ):
            raise RuntimeError(f"/run/{NAMESPACE} must remain root:{GROUP} 0710")
        return created


if __name__ == "__main__":
    try:
        if prepare():
            print("created")
    except (OSError, RuntimeError) as error:
        print(f"Runner WSS host preparation failed: {error}", file=sys.stderr)
        sys.exit(1)
