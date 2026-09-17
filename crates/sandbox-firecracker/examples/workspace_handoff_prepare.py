"""Prepare an exclusively owned synthetic KVM study directory; requires root."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import uuid


def run(*args):
    return subprocess.run(
        args, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=300
    ).stdout


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def prepare(args):
    if os.geteuid() != 0:
        raise PermissionError("KVM study preparation requires root")
    inputs = [args.rootfs, args.kernel, args.firecracker]
    inputs += [args.guest_bin_dir / name for name in (
        "guest-init", "guest-workspace-mount", "guest-state-restore"
    )]
    for path in inputs:
        if not path.is_file():
            raise ValueError(f"missing artifact: {path}")
    root = args.study_root.absolute()
    if root.resolve() != root:
        raise ValueError("study root must not contain symlink components")
    root.mkdir(mode=0o700, parents=False, exist_ok=False)
    identities = {"source_revision": args.source_revision}
    run("cp", "--reflink=auto", "--sparse=always", "--", str(args.rootfs), str(root / "rootfs.ext4"))
    identities["base_rootfs_sha256"] = digest(root / "rootfs.ext4")
    for name in ("guest-init", "guest-workspace-mount", "guest-state-restore"):
        source = (args.guest_bin_dir / name).resolve()
        # debugfs tokenizes its command itself; avoid ambiguous filenames.
        if any(character.isspace() for character in str(source)) or '"' in str(source):
            raise ValueError("guest binary paths must not contain whitespace or quotes")
        destination = "/usr/sbin/" + name
        run("debugfs", "-w", "-R", "rm " + destination, str(root / "rootfs.ext4"))
        run("debugfs", "-w", "-R", f"write {source} {destination}", str(root / "rootfs.ext4"))
        run("debugfs", "-w", "-R", f"set_inode_field {destination} mode 0100755", str(root / "rootfs.ext4"))
        embedded = run("debugfs", "-R", "cat " + destination, str(root / "rootfs.ext4"))
        identities[name] = digest(source)
        if hashlib.sha256(embedded).hexdigest() != identities[name]:
            raise ValueError(f"embedded binary mismatch: {name}")
    fixture = root / "fixture"
    fixture.mkdir()
    (fixture / "data").mkdir()
    for index in range(128):
        (fixture / "data" / f"file-{index:03}").write_bytes(
            hashlib.sha256(f"34729:{index}".encode()).digest() * 128
        )
    (fixture / "large.bin").write_bytes(bytes(range(256)) * (32 * 1024 * 1024 // 256))
    (fixture / "identity").write_text("synthetic-workspace-34729-v1\n")
    (fixture / "empty").touch()
    os.link(fixture / "data/file-000", fixture / "hardlink")
    (fixture / "symlink").symlink_to("data/file-003")
    for path in [fixture, *fixture.rglob("*")]:
        os.chown(path, 1000, 1000, follow_symlinks=False)
        if not path.is_symlink():
            path.chmod(0o750 if path.is_dir() else 0o640)
        os.utime(path, (1700000000, 1700000000), follow_symlinks=False)
    entries = []
    for path in sorted(fixture.rglob("*")):
        metadata = path.lstat()
        row = {
            "path": str(path.relative_to(fixture)),
            "mode": stat.S_IMODE(metadata.st_mode),
            "uid": metadata.st_uid,
            "gid": metadata.st_gid,
            "mtime": int(metadata.st_mtime),
        }
        if path.is_symlink():
            row["symlink"] = os.readlink(path)
        elif path.is_file():
            row.update(size=metadata.st_size, sha256=digest(path))
        else:
            row["directory"] = True
        entries.append(row)
    (root / "expected.json").write_text(json.dumps({"entries": entries, "hardlink_equal": True}, indent=2))
    with (root / "fixture.ext4").open("xb") as image:
        image.truncate(10240 * 1024 * 1024)
    run("mkfs.ext4", "-F", "-q", "-d", str(fixture), str(root / "fixture.ext4"))
    shutil.copyfile(args.firecracker, root / "firecracker")
    (root / "firecracker").chmod(0o755)
    shutil.copyfile(args.kernel, root / "vmlinux")
    for name in ("firecracker", "vmlinux", "rootfs.ext4", "fixture.ext4"):
        identities[name] = digest(root / name)
    config = {
        "binary": str(root / "firecracker"), "kernel": str(root / "vmlinux"),
        "rootfs": str(root / "rootfs.ext4"), "vcpu": 2, "memory_mb": 4096, "disk_mb": 10240,
    }
    (root / "snapshot-id").write_text("handoff-study-" + uuid.uuid4().hex[:16])
    (root / "config.json").write_text(json.dumps(config, indent=2))
    (root / "artifacts.json").write_text(json.dumps(identities, indent=2))
    print(json.dumps(identities))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("study_root", type=Path)
    parser.add_argument("--rootfs", type=Path, required=True)
    parser.add_argument("--kernel", type=Path, required=True)
    parser.add_argument("--firecracker", type=Path, required=True)
    parser.add_argument("--guest-bin-dir", type=Path, required=True)
    parser.add_argument("--source-revision", required=True)
    prepare(parser.parse_args())
