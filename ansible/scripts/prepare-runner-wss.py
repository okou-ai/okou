#!/usr/bin/env python3
"""Prepare persistent host prerequisites; never repair existing WSS state.

Used by Ansible and cached SSH starts. Caddy need not be installed or running.
Provision, build, promote and rollback share the Ansible task. Image, preview
and developer SSH starts run this same file even when their binary is cached.
Only root writes the namespace; Caddy's dedicated group can traverse/connect.
Existing sockets and private Runner subtrees are never enumerated or changed.
"""

import fcntl
import grp
import os
import stat
import subprocess
import sys
from contextlib import ExitStack

GROUP_NAME = "okou-wss-caddy"
DIRECTORY_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC


def open_directory(stack, name, parent=None):
    descriptor = os.open(name, DIRECTORY_FLAGS, dir_fd=parent)
    stack.callback(os.close, descriptor)
    return descriptor


def validate_parent(descriptor, path):
    metadata = os.fstat(descriptor)
    if (
        metadata.st_uid != 0
        or stat.S_IMODE(metadata.st_mode) & 0o022
        or not stat.S_IMODE(metadata.st_mode) & 0o001
    ):
        raise RuntimeError(f"{path} must be root-owned, traversable and not group/world-writable")
    if "system.posix_acl_default" in os.listxattr(descriptor):
        raise RuntimeError(f"{path} must not pass default ACLs to the WSS namespace")


def dedicated_group():
    try:
        group_id = grp.getgrnam(GROUP_NAME).gr_gid
    except KeyError:
        result = subprocess.run(["groupadd", "--system", GROUP_NAME], check=False)
        # A concurrent preparer may have created exactly this group. Any other
        # failed creation remains an error; never use another group's GID.
        try:
            group_id = grp.getgrnam(GROUP_NAME).gr_gid
        except KeyError as error:
            raise RuntimeError(f"dedicated group creation failed ({result.returncode})") from error
    if group_id == 0:
        raise RuntimeError(f"{GROUP_NAME} must be distinct from the root group")
    return group_id


def prepare(root="/", group_id=None):
    if os.geteuid() != 0:
        raise RuntimeError("preparation requires root")
    group_id = dedicated_group() if group_id is None else group_id
    if group_id == 0:
        raise RuntimeError(f"{GROUP_NAME} must be distinct from the root group")
    with ExitStack() as stack:
        root_fd = open_directory(stack, root)
        validate_parent(root_fd, "/")
        var = open_directory(stack, "var", root_fd)
        validate_parent(var, "/var")
        lib = open_directory(stack, "lib", var)
        validate_parent(lib, "/var/lib")
        # Serialize cooperating creators before any initially private directory
        # becomes traversable. The parent inode remains stable across runs.
        fcntl.flock(lib, fcntl.LOCK_EX)
        created = False
        try:
            home = open_directory(stack, "vm0-runner", lib)
        except FileNotFoundError:
            os.mkdir("vm0-runner", 0o700, dir_fd=lib)
            home = open_directory(stack, "vm0-runner", lib)
            os.fchown(home, 0, 0)
            os.fchmod(home, 0o755)
            created = True
        validate_parent(home, "/var/lib/vm0-runner")
        try:
            namespace = open_directory(stack, "wss", home)
        except FileNotFoundError:
            os.mkdir("wss", 0o700, dir_fd=home)
            namespace = open_directory(stack, "wss", home)
            os.fchown(namespace, 0, group_id)
            os.fchmod(namespace, 0o710)
            created = True
        if {"system.posix_acl_access", "system.posix_acl_default"}.intersection(
            os.listxattr(namespace)
        ):
            raise RuntimeError("WSS namespace must not have POSIX ACLs")
        metadata = os.fstat(namespace)
        pathname = os.stat("wss", dir_fd=home, follow_symlinks=False)
        if (
            metadata.st_uid != 0
            or metadata.st_gid != group_id
            or stat.S_IMODE(metadata.st_mode) != 0o710
            or (metadata.st_dev, metadata.st_ino) != (pathname.st_dev, pathname.st_ino)
        ):
            raise RuntimeError("/var/lib/vm0-runner/wss must remain root:okou-wss-caddy 0710")
        os.fsync(namespace)
        os.fsync(home)
        os.fsync(lib)
        return created


if __name__ == "__main__":
    try:
        if prepare():
            print("created")
    except (KeyError, OSError, RuntimeError) as error:
        print(f"Runner WSS host preparation failed: {error}", file=sys.stderr)
        sys.exit(1)
