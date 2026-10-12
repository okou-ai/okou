#!/usr/bin/env python3
"""Read-only validation of the protected namespace consumed by Caddy."""

import errno
import grp
import os
import stat
from pathlib import Path


def validate_namespace(directory: Path, group_id: int) -> None:
    if group_id == 0:
        raise ValueError("WSS group must differ from root")
    for path in [*reversed(directory.parents), directory]:
        metadata = path.lstat()
        mode = stat.S_IMODE(metadata.st_mode)
        valid_permissions = (
            metadata.st_gid == group_id and mode == 0o710
            if path == directory
            else not mode & 0o022 and bool(mode & 0o001)
        )
        if (
            not stat.S_ISDIR(metadata.st_mode)
            or metadata.st_uid != 0
            or not valid_permissions
        ):
            raise ValueError(f"Unsafe WSS directory owner, group or mode: {path}")
        for attribute in ["system.posix_acl_access", "system.posix_acl_default"]:
            try:
                os.getxattr(path, attribute, follow_symlinks=False)
            except OSError as error:
                if error.errno not in [errno.ENODATA, errno.ENOTSUP]:
                    raise
            else:
                raise ValueError(f"Unexpected ACL on WSS directory: {path}")


if __name__ == "__main__":
    validate_namespace(
        Path("/var/lib/vm0-runner/wss"), grp.getgrnam("okou-runner-caddy").gr_gid
    )
