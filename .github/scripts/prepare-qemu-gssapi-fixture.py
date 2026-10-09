#!/usr/bin/env python3
"""Build QEMU9.2 twice in a private signed Noble native sysroot.

APT downloads only; no installation/maintainer script, host configuration or KDC.
A disposable mount/PID namespace confines the build; build commands run as the
ordinary owner with an empty environment. Runtime is a separate explicit mode.
"""
import argparse
import contextlib
import hashlib
import json
import lzma
import os
import pathlib
import platform
import pwd
import re
import resource
import shutil
import signal
import stat
import subprocess
import sys
import tarfile
import tempfile
import time

SNAPSHOT = "20260521T000000Z"
# The official snapshot's signed InRelease declares both amd64 and arm64
# Packages indexes. Use the explicit frozen URI, not ports' unsupported APT
# snapshot auto-negotiation or an unversioned/latest bootstrap repository.
SNAPSHOT_ORIGIN = "https://snapshot.ubuntu.com/ubuntu/" + SNAPSHOT
QEMU_MEMBER_COUNT = 81379
QEMU_MEMBER_BYTES = 647679574
QEMU_SOURCE_EPOCH = 1733874468
# This archive-covered macOS EDK2 emulator development alias is not a
# QEMU softmmu build input. Never extract it, normalize it to a host path or
# disable the extraction filter. Exact source identity/shape still covers it.
EXCLUDED_SOURCE_ALIAS = ("qemu-9.2.0/roms/edk2/EmulatorPkg/Unix/Host/X11IncludeHack", "/opt/X11/include")

REPO = pathlib.Path(__file__).resolve().parents[2]
QEMU_SHA256 = "f859f0bc65e1f533d040bbe8c92bcfecee5af2c921a6687c652fb44d089bd894"
VNC_SHA256 = "3dfd2c4be76597983641fde3d99b64ac5b0d6a56b59e4d6a08edacc95075bc2d"
FIRMWARE = {
    "bios-256k.bin": "f1d4f396011197eb989029659cde250751cc711c336b8fbbe6f77cfe0dc5dcd8",
    "vgabios-stdvga.bin": "651513519f9e0d5b99d3b051a8f5c68db69e987339b59a441d371068c34c146b",
}
CONFIGURE = ["--prefix=/usr", "--sysconfdir=/etc", "--localstatedir=/var",
             "--target-list=x86_64-softmmu", "--without-default-features",
             "--enable-tcg", "--enable-vnc", "--enable-vnc-sasl", "--enable-gnutls",
             "--enable-pixman", "--enable-fdt=system", "--disable-modules", "--disable-plugins", "--disable-kvm", "--disable-tools",
             "--disable-guest-agent", "--disable-docs", "--disable-download"]
MIT = "1.20.1-6ubuntu2"
CYRUS = "2.1.28+dfsg1-5ubuntu3"
# Preserve the reviewed independent-server identities. The production client
# still uses MIT1.22.2. Updates/Security are frozen to the same signed snapshot.
GNUTLS = "3.8.3-1.1ubuntu3.6"
KERBEROS = ("krb5-user", "krb5-kdc", "krb5-admin-server", "libgssapi-krb5-2",
            "libkrb5-3", "libk5crypto3", "libkrb5support0", "libkdb5-10t64",
            "libkadm5clnt-mit12", "libkadm5srv-mit12", "libgssrpc4t64")
REQUIRED = (*KERBEROS, "libverto-libevent1t64", "libsasl2-2", "libsasl2-modules-gssapi-mit",
            "libgnutls30t64", "bash", "dash", "bzip2", "diffutils", "coreutils", "grep", "sed", "gawk", "findutils", "iproute2",
            "make", "gcc", "g++", "gcc-13", "g++-13", "binutils", "libc6-dev", "pkgconf",
            "ninja-build", "python3", "python3-venv", "python3.12", "python3.12-venv", "libglib2.0-dev",
            "libpixman-1-dev", "libfdt-dev", "zlib1g-dev", "libgnutls28-dev", "libsasl2-dev", "openssl")
SEEDS = {"dash": "0.5.12-6ubuntu5", "bzip2": "1.0.8-5.1", "diffutils": "1:3.10-1build1", "gcc-13": "13.2.0-23ubuntu4", "g++-13": "13.2.0-23ubuntu4", "binutils": "2.42-4ubuntu2",
         "libc6-dev": "2.39-0ubuntu8", "libglib2.0-dev": "2.80.0-6ubuntu1", "libpixman-1-dev": "0.42.2-1build1",
         "libfdt-dev": "1.7.0-2build1", "zlib1g-dev": "1:1.3.dfsg-3.1ubuntu2", "python3.12": "3.12.3-1",
         "python3.12-venv": "3.12.3-1", "python3": "3.12.3-0ubuntu1", "python3-venv": "3.12.3-0ubuntu1",
         "ninja-build": "1.11.1-2", "pkgconf": "1.8.1-2build1",
         "make": "4.3-4.1build2", "libgnutls28-dev": GNUTLS, "libsasl2-dev": CYRUS}


def call(argv, *, cwd=None, timeout=300):
    environment = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C.UTF-8"}
    if pathlib.Path(argv[0]).name in ("apt-get", "apt-cache", "apt-config"):
        if cwd is None:
            raise ValueError("private APT startup root required")
        configuration = pathlib.Path(cwd) / "apt.conf"
        if not configuration.is_file() or configuration.is_symlink() or configuration.stat().st_uid != os.geteuid():
            raise ValueError("private APT startup configuration required")
        environment["APT_CONFIG"] = str(configuration)
    result = subprocess.run([str(x) for x in argv], cwd=cwd, text=True, capture_output=True,
                            timeout=timeout, env=environment)
    if result.returncode:
        if cwd and pathlib.Path(cwd).name.startswith("signed-noble-"):
            (pathlib.Path(cwd) / "provision-error.log").write_text(result.stdout + result.stderr)
        raise RuntimeError("source-pinned fixture step refused: " + pathlib.Path(argv[0]).name)
    return result.stdout


def private_apt_config(base, arch):
    if arch not in ("amd64", "arm64") or base.resolve() != base or base.is_symlink():
        raise ValueError("private APT configuration root refused")
    path = base / "apt.conf"
    # APT_CONFIG is read BEFORE global fragments/main. CLI -o flags are too
    # late to prevent ambient hooks or binary-specific startup configuration.
    with path.open("x") as configuration:
        configuration.write('Dir::Etc::Parts "-";\nDir::Etc::Main "-";\n'
                            'Dir::Etc::trusted "-";\nDir::Etc::trustedparts "-";\n')
    path.chmod(0o600)
    return path


def retain_public_inputs(base, stage, manifest=None):
    # Retain originals on failures too. These contain only public package/build
    # inputs; no fixture credentials exist in this producer.
    evidence = base / "public-evidence"
    evidence.mkdir(mode=0o700, exist_ok=True)
    records = {}
    for path in sorted((base / "state/lists").glob("*")):
        if path.is_file() and not path.is_symlink() and (path.name.endswith("InRelease") or "_Packages" in path.name):
            destination = evidence / path.name
            if not destination.exists():
                shutil.copyfile(path, destination)
            if sha(destination) != sha(path):
                raise ValueError("retained original signed index changed")
            records[path.name] = {"sha256": sha(path), "sizeBytes": path.stat().st_size}
    payload = {"stage": stage, "nativeArchitecture": platform.machine(), "snapshot": SNAPSHOT,
               "originalIndexStorage": "APT retained InRelease and Packages; local compression is declared",
               "indexes": records, "runtimeVerified": False, "attributionVerified": False}
    if manifest is not None:
        payload["provision"] = manifest
        if stage == "provision-complete":
            # Preserve the actual already-downloaded payloads once, before any
            # source/build failure. A declaration alone is not original custody.
            # Failure retention does not replay a partial archive-copy attempt.
            payload["packageArchives"] = retain_public_package_archives(base, manifest["packages"])
    with (evidence / (stage + ".json")).open("x") as output:
        json.dump(payload, output, indent=2)
        output.write("\n")


def sha(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for data in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(data)
    return digest.hexdigest()


def retain_public_package_archives(base, packages):
    """Bounded original-byte custody only; no signature or runtime admission."""
    if not isinstance(packages, dict) or not 1 <= len(packages) <= 200:
        raise ValueError("public package archive count refused")
    expected = {}
    total = 0
    for name, row in packages.items():
        digest, size = row["archiveSha256"], row["archiveSizeBytes"]
        if (not isinstance(name, str) or not 1 <= len(name.encode()) <= 255
                or not isinstance(digest, str) or len(digest) != 64
                or any(char not in "0123456789abcdef" for char in digest)
                or type(size) is not int or not 0 < size <= 128 * 1024 * 1024
                or digest in expected):
            raise ValueError("public package archive identity refused")
        total += size
        if total > 512 * 1024 * 1024:
            raise ValueError("public package archive byte budget refused")
        expected[digest] = (name, size)
    if base.is_symlink() or base.resolve(strict=True) != base:
        raise ValueError("public package archive root refused")
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
    inode_fields = ("st_dev", "st_ino", "st_mode", "st_uid", "st_gid", "st_nlink",
                    "st_size", "st_mtime_ns", "st_ctime_ns")
    try:
        with contextlib.ExitStack() as opened:
            base_fd = os.open(base, flags)
            opened.callback(os.close, base_fd)
            if os.fstat(base_fd).st_uid != os.geteuid():
                raise ValueError("public package archive root owner refused")
            cache_fd = os.open("cache", flags, dir_fd=base_fd)
            opened.callback(os.close, cache_fd)
            archives_fd = os.open("archives", flags, dir_fd=cache_fd)
            opened.callback(os.close, archives_fd)
            evidence_fd = os.open("public-evidence", flags, dir_fd=base_fd)
            opened.callback(os.close, evidence_fd)
            if any(os.fstat(fd).st_uid != os.geteuid() for fd in (cache_fd, archives_fd, evidence_fd)):
                raise ValueError("public package archive directory owner refused")
            # Exactly one new storage view; no following aliases, overwriting,
            # or treating a prior/partial publication as a completed attempt.
            os.mkdir("package-archives", mode=0o700, dir_fd=evidence_fd)
            storage_fd = os.open("package-archives", flags, dir_fd=evidence_fd)
            opened.callback(os.close, storage_fd)
            names = []
            count = 0
            with os.scandir(archives_fd) as entries:
                for entry in entries:
                    count += 1
                    if count > 202:
                        raise ValueError("public package archive directory budget refused")
                    if entry.name in ("lock", "partial"):
                        continue
                    if not entry.name.endswith(".deb") or len(names) == 200:
                        raise ValueError("unexpected public package archive entry")
                    names.append(entry.name)
            if len(names) != len(expected):
                raise ValueError("public package archive closure incomplete")
            records = {}
            for filename in sorted(names):
                with os.fdopen(os.open(filename, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW | os.O_CLOEXEC,
                                       dir_fd=archives_fd), "rb") as source:
                    before = os.fstat(source.fileno())
                    if (not stat.S_ISREG(before.st_mode) or before.st_uid != os.geteuid()
                            or before.st_nlink != 1 or not 0 < before.st_size <= 128 * 1024 * 1024):
                        raise ValueError("public package archive source refused")
                    # Resolve by actual bytes, never by a package/cache pathname.
                    digest = hashlib.sha256()
                    read = 0
                    for data in iter(lambda: source.read(1024 * 1024), b""):
                        read += len(data)
                        if read > before.st_size:
                            raise ValueError("public package archive source grew")
                        digest.update(data)
                    archive_hash = digest.hexdigest()
                    if archive_hash not in expected or archive_hash in records:
                        raise ValueError("public package archive digest refused")
                    package, size = expected[archive_hash]
                    if size != read or size != before.st_size:
                        raise ValueError("public package archive size refused")
                    source.seek(0)
                    retained_name = archive_hash + ".deb"
                    with os.fdopen(os.open(retained_name, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                                           0o600, dir_fd=storage_fd), "w+b") as retained:
                        copied = 0
                        for data in iter(lambda: source.read(1024 * 1024), b""):
                            copied += len(data)
                            if copied > size:
                                raise ValueError("public package archive copy budget refused")
                            retained.write(data)
                        retained.flush()
                        retained.seek(0)
                        digest = hashlib.sha256()
                        checked = 0
                        for data in iter(lambda: retained.read(1024 * 1024), b""):
                            checked += len(data)
                            if checked > size:
                                raise ValueError("retained public package archive grew")
                            digest.update(data)
                        final = os.fstat(retained.fileno())
                        named = os.stat(retained_name, dir_fd=storage_fd, follow_symlinks=False)
                        if (copied != size or checked != size or digest.hexdigest() != archive_hash
                                or not stat.S_ISREG(final.st_mode) or stat.S_IMODE(final.st_mode) != 0o600
                                or final.st_uid != os.geteuid() or final.st_nlink != 1
                                or tuple(getattr(final, field) for field in inode_fields)
                                != tuple(getattr(named, field) for field in inode_fields)):
                            raise ValueError("retained public package archive mismatch")
                    after = os.fstat(source.fileno())
                    named = os.stat(filename, dir_fd=archives_fd, follow_symlinks=False)
                    if (tuple(getattr(before, field) for field in inode_fields)
                            != tuple(getattr(after, field) for field in inode_fields)
                            or tuple(getattr(before, field) for field in inode_fields)
                            != tuple(getattr(named, field) for field in inode_fields)):
                        raise ValueError("public package archive source changed")
                    records[archive_hash] = {"package": package, "sha256": archive_hash,
                                            "sizeBytes": size, "storagePath": "package-archives/" + retained_name}
            if set(records) != set(expected):
                raise ValueError("public package archive closure incomplete")
            for parent_fd, name, fd in ((base_fd, "cache", cache_fd), (cache_fd, "archives", archives_fd),
                                         (base_fd, "public-evidence", evidence_fd),
                                         (evidence_fd, "package-archives", storage_fd)):
                held, named = os.fstat(fd), os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
                if (not stat.S_ISDIR(named.st_mode) or held.st_dev != named.st_dev
                        or held.st_ino != named.st_ino or named.st_uid != os.geteuid()):
                    raise ValueError("public package archive directory changed")
            held, named = os.fstat(base_fd), os.stat(base, follow_symlinks=False)
            if (base.resolve(strict=True) != base or not stat.S_ISDIR(named.st_mode)
                    or held.st_dev != named.st_dev or held.st_ino != named.st_ino
                    or named.st_uid != os.geteuid()):
                raise ValueError("public package archive root changed")
            return {row["package"]: row for row in records.values()}
    except OSError as error:
        raise ValueError("public package archive custody refused") from error


def verify_elf_header(data, arch):
    if len(data) < 64 or data[:6] != b"\x7fELF\x02\x01" or int.from_bytes(data[18:20], "little") != {"x86_64": 62, "aarch64": 183}[arch]:
        raise ValueError("source-pinned fixture native ELF architecture refused")


def source_member(name):
    path = pathlib.PurePosixPath(name)
    if path.is_absolute() or ".." in path.parts or not path.parts or path.parts[0] != "qemu-9.2.0":
        raise ValueError("source-pinned fixture archive path refused")
    return pathlib.PurePosixPath(*path.parts[1:])


def inventory(root):
    # One committed measurement implementation, through its inert-only CLI.
    # No dynamic import/search-path override or new materialized test source.
    script = REPO / "crates/rfb-client/tests/fixtures/qemu_gssapi.py"
    result = subprocess.run([sys.executable, "-I", "-S", "-B", str(script), "--runtime-dir", str(root), "--inventory-only"],
                            capture_output=True, text=True, timeout=300,
                            env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C.UTF-8"})
    if result.returncode:
        raise ValueError(f"source-pinned complete input measurement refused (exit {result.returncode}):\n{result.stderr}")
    measured = json.loads(result.stdout)
    tree = measured["tree"]
    digest = hashlib.sha256(b"qemu-full-private-tree-v2\x00" + json.dumps(
        tree, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()).hexdigest()
    if (tree["schemaVersion"] != 2 or measured["measurementOnly"] is not True
            or measured["runtimeVerified"] is not False or measured["attributionVerified"] is not False
            or measured["treeSha256"] != digest):
        raise ValueError("source-pinned complete input measurement identity refused")
    return tree, digest


class PackageExtractionBudget:
    """One provision-wide budget; lower test limits cannot widen production caps."""
    def __init__(self, *, payload_bytes=512 * 1024 * 1024,
                 total_bytes=4 * 1024 * 1024 * 1024, entries=400000, name_bytes=64 * 1024 * 1024,
                 output_nodes=20000, output_bytes=2 * 1024 * 1024 * 1024,
                 output_names=8 * 1024 * 1024):
        for value, maximum in ((payload_bytes, 512 * 1024 * 1024),
                               (total_bytes, 4 * 1024 * 1024 * 1024),
                               (entries, 400000), (name_bytes, 64 * 1024 * 1024),
                               (output_nodes, 20000), (output_bytes, 2 * 1024 * 1024 * 1024),
                               (output_names, 8 * 1024 * 1024)):
            if type(value) is not int or not 0 < value <= maximum:
                raise ValueError("package extraction budget refused")
        self.payload_bytes = payload_bytes
        self.remaining_bytes = total_bytes
        self.remaining_payload_bytes = 4 * 1024 * 1024 * 1024
        self.remaining_entries = entries
        self.remaining_names = name_bytes
        self.output_node_limit = output_nodes
        self.output_byte_limit = output_bytes
        self.output_name_limit = output_names
        self.output_root = None
        self.output_sizes = {}
        self.output_bytes = 0
        self.output_names = 0

    def reserve_output_path(self, relative, size):
        # A monotonic high-water reservation, not a source/writer seal. Count
        # each regular NAME separately, including names sharing one inode.
        parts = pathlib.PurePosixPath(relative).parts
        if (type(size) is not int or not 0 <= size <= 128 * 1024 * 1024
                or len(parts) > 128 or len(os.fsencode(relative)) > 4096):
            raise ValueError("package output path/byte budget refused")
        for index in range(len(parts) + 1):
            name = "/".join(parts[:index])
            requested = size if index == len(parts) else 0
            previous = self.output_sizes.get(name, 0)
            new_node = name not in self.output_sizes
            # The eventual complete-tree measurement enumerates every child
            # name twice (initial scan and rescan); reserve both before writes.
            width = 2 * len(os.fsencode(parts[index - 1])) if new_node and index else 0
            growth = max(0, requested - previous)
            if (len(self.output_sizes) + new_node > self.output_node_limit
                    or self.output_names + width > self.output_name_limit
                    or self.output_bytes + growth > self.output_byte_limit):
                raise ValueError("package output aggregate budget refused")
            self.output_sizes[name] = max(previous, requested)
            self.output_names += width
            self.output_bytes += growth

    def bind_output_root(self, root):
        if root.is_symlink() or root.resolve(strict=True) != root:
            raise ValueError("package output root refused")
        metadata = root.stat()
        identity = (str(root), metadata.st_dev, metadata.st_ino)
        if self.output_root is not None:
            if self.output_root != identity:
                raise ValueError("package output root changed")
            return
        self.output_root = identity
        self.reserve_output_path("", 0)
        pending = [root]
        while pending:
            parent = pending.pop()
            # Refuse each discovered excess node before collecting a directory
            # list. Do not follow aliases or omit an existing output prefix.
            with os.scandir(parent) as entries:
                for entry in entries:
                    info = entry.stat(follow_symlinks=False)
                    if not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode)):
                        raise ValueError("package output node refused")
                    path = parent / entry.name
                    self.reserve_output_path(str(path.relative_to(root)), info.st_size if stat.S_ISREG(info.st_mode) else 0)
                    if stat.S_ISDIR(info.st_mode):
                        pending.append(path)

    def reserve_output(self, root, member, stream):
        self.bind_output_root(root)
        # Use the maintained filter before reserving, then let extractall apply
        # it again immediately before its write. Resolve the current parent,
        # not a stale archive-name ledger: earlier headers can change aliases.
        tarfile.data_filter(member, str(root))
        destination = root / member.name
        destination = destination.parent.resolve() / destination.name
        if not destination.is_relative_to(root):
            raise ValueError("package output parent escaped")
        size = member.size if member.isfile() else 0
        if member.islnk():
            target = root / member.linkname
            if destination.is_symlink():
                raise ValueError("source-pinned fixture package file collision refused")
            if os.path.lexists(target) and not destination.exists():
                info = target.lstat()
                size = info.st_size if stat.S_ISREG(info.st_mode) else 0
            else:
                # Missing targets and EEXIST use the archived-target fallback,
                # not necessarily the current filesystem target's bytes.
                with stream.extractfile(member) as source:
                    size = source.seek(0, os.SEEK_END)
            # Conservatively charge every possible hardlink copy, including
            # repeated names, before late collision hashing or extraction.
            if size > self.remaining_bytes:
                raise ValueError("package aggregate extraction budget refused")
            self.remaining_bytes -= size
        self.reserve_output_path(str(destination.relative_to(root)), size)

    def reserve_future_outputs(self, root):
        self.bind_output_root(root)
        # Conservative maxima for the later native binary, both pinned BIOS
        # copies and CA bundle; this reserves capacity, not their admission.
        for name in ("usr/bin/qemu-system-x86_64", "usr/share/seabios/bios.bin",
                     "usr/share/seabios/vgabios-stdvga.bin", "etc/ssl/certs/ca-certificates.crt"):
            self.reserve_output_path(name, 128 * 1024 * 1024)
        for name in ("bin", "sbin", "lib", "lib64", "usr/bin/cc", "usr/bin/c++", "usr/bin/awk",
                     "usr/bin/pkg-config", "usr/sbin/rmt", "etc/localtime", "usr/share/qemu",
                     "proc", "dev", "run", "repo", "contract", "build", "source", "tmp"):
            self.reserve_output_path(name, 0)

    def reserve_header(self):
        if self.remaining_entries == 0:
            raise ValueError("package aggregate extraction budget refused")
        self.remaining_entries -= 1

    def reserve(self, members):
        size = sum(member.size for member in members if member.isfile())
        names = sum(len(member.name.encode("utf-8", "surrogateescape"))
                    + len(member.linkname.encode("utf-8", "surrogateescape")) for member in members)
        if size > self.remaining_bytes or names > self.remaining_names:
            raise ValueError("package aggregate extraction budget refused")
        # Charge repeated/colliding files too; never deduplicate to bypass caps.
        self.remaining_bytes -= size
        self.remaining_names -= names


def bounded_archive(fileobj, *, headers, member_bytes, entry_error, package_budget=None,
                    archive_class=tarfile.TarFile):
    """Guard raw headers and extensions before the maintained tar parser consumes them."""
    counts = {"headers": 0, "depth": 0, "extensions": 0, "names": 0, "bytes": 0, "pax": 0}

    def size_allowed(size):
        if type(size) is not int or not 0 <= size <= 128 * 1024 * 1024:
            raise ValueError("archive file byte budget refused")

    class BoundedInfo(tarfile.TarInfo):
        def _proc_member(self, archive):
            if counts["headers"] == headers:
                raise ValueError(entry_error)
            counts["headers"] += 1
            if package_budget is not None:
                package_budget.reserve_header()
            if counts["depth"] == 8:
                raise ValueError("archive extension depth refused")
            counts["depth"] += 1
            try:
                if self.type in (tarfile.XHDTYPE, tarfile.XGLTYPE, tarfile.SOLARIS_XHDTYPE,
                                 tarfile.GNUTYPE_LONGNAME, tarfile.GNUTYPE_LONGLINK):
                    if not 0 <= self.size <= 64 * 1024 or counts["extensions"] + self.size > 8 * 1024 * 1024:
                        raise ValueError("archive extension budget refused")
                    counts["extensions"] += self.size
                else:
                    size_allowed(self.size)
                self._physical_size = self.size
                self._physical_data_start = archive.fileobj.tell()
                result = super()._proc_member(archive)
                size_allowed(result.size)
                if counts["depth"] == 1:
                    names = [result.name, result.linkname, result.uname, result.gname]
                    lengths = [len(name.encode("utf-8", "surrogateescape")) for name in names]
                    if max(lengths) > 4096 or counts["names"] + sum(lengths) > 32 * 1024 * 1024:
                        raise ValueError("archive path byte budget refused")
                    counts["names"] += sum(lengths)
                    counts["pax"] += len(result.pax_headers)
                    if counts["pax"] > 100000:
                        raise ValueError("archive retained metadata budget refused")
                    counts["bytes"] += result.size if result.isfile() else 0
                    if counts["bytes"] > member_bytes:
                        raise ValueError("archive total file byte budget refused")
                return result
            finally:
                counts["depth"] -= 1

        def _proc_sparse(self, archive):
            # GNU old sparse metadata is read by the maintained parser. Each
            # extra block would allocate 21 more entries; cap BEFORE that read.
            size_allowed(self._sparse_structs[2])
            original = archive.fileobj
            class SparseBlocks:
                remaining = 48
                def read(self, size):
                    if self.remaining == 0:
                        raise ValueError("archive sparse metadata budget refused")
                    self.remaining -= 1
                    return original.read(size)
                def tell(self):
                    return original.tell()
            archive.fileobj = SparseBlocks()
            try:
                result = super()._proc_sparse(archive)
            finally:
                archive.fileobj = original
            self.check_sparse(result, self._physical_size)
            return result

        def _proc_gnusparse_00(self, next_member, pax_headers, buf):
            if buf.count(b"GNU.sparse.offset=") > 1024 or buf.count(b"GNU.sparse.numbytes=") > 1024:
                raise ValueError("archive sparse metadata budget refused")
            super()._proc_gnusparse_00(next_member, pax_headers, buf)

        def _proc_gnusparse_01(self, next_member, pax_headers):
            if pax_headers["GNU.sparse.map"].count(",") >= 2048:
                raise ValueError("archive sparse metadata budget refused")
            super()._proc_gnusparse_01(next_member, pax_headers)

        def _proc_gnusparse_10(self, next_member, pax_headers, archive):
            original = archive.fileobj
            class SparseBlocks:
                remaining = 64
                first = True
                def read(self, size):
                    if self.remaining == 0:
                        raise ValueError("archive sparse metadata budget refused")
                    self.remaining -= 1
                    data = original.read(size)
                    if self.first:
                        self.first = False
                        count = data.split(b"\n", 1)[0]
                        if len(count) > 10 or not count.isdigit() or int(count) > 1024:
                            raise ValueError("archive sparse metadata budget refused")
                    return data
                def tell(self):
                    return original.tell()
            archive.fileobj = SparseBlocks()
            try:
                super()._proc_gnusparse_10(next_member, pax_headers, archive)
            finally:
                archive.fileobj = original

        @staticmethod
        def check_sparse(member, physical_size):
            if member.sparse is None:
                return
            size_allowed(member.size)
            end, dense_bytes = 0, 0
            for offset, length in member.sparse:
                if offset == 0 and length == 0:
                    continue  # Unused slots in the old GNU fixed sparse header.
                if offset < end or length < 0 or offset + length > member.size:
                    raise ValueError("archive sparse extent refused")
                end = offset + length
                dense_bytes += length
            if dense_bytes != physical_size:
                raise ValueError("archive sparse physical byte accounting refused")
            if len(member.sparse) > 1024:
                raise ValueError("archive sparse metadata budget refused")

        def _proc_pax(self, archive):
            result = super()._proc_pax(archive)
            physical_size = result._physical_size
            if result.type != tarfile.GNUTYPE_SPARSE:
                # PAX1.0 map blocks are included in the raw file size; old GNU
                # continuation blocks and PAX0.x metadata are not dense data.
                physical_size -= result.offset_data - result._physical_data_start
            self.check_sparse(result, physical_size)
            return result

    return archive_class.open(fileobj=fileobj, mode="r:", tarinfo=BoundedInfo)


def collect_package_archives(directory, *, files=200, file_bytes=128 * 1024 * 1024,
                             total_bytes=512 * 1024 * 1024):
    # Apply the existing original-custody limits BEFORE any decoder/retention,
    # and stop enumerating at the physical directory bound, not after sorting.
    for value, maximum in ((files, 200), (file_bytes, 128 * 1024 * 1024),
                           (total_bytes, 512 * 1024 * 1024)):
        if type(value) is not int or not 0 < value <= maximum:
            raise ValueError("package compressed archive budget refused")
    if directory.is_symlink() or directory.resolve(strict=True) != directory:
        raise ValueError("source-pinned fixture archive directory refused")
    archives, total, entries = [], 0, 0
    with os.scandir(directory) as scan:
        for entry in scan:
            entries += 1
            if entries > files + 2:
                raise ValueError("package compressed archive directory budget refused")
            if entry.name in ("lock", "partial"):
                continue
            metadata = entry.stat(follow_symlinks=False)
            if (not entry.name.endswith(".deb") or len(os.fsencode(entry.name)) > 255
                    or not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.geteuid()):
                raise ValueError("source-pinned fixture archive refused")
            if len(archives) == files or not 0 < metadata.st_size <= file_bytes:
                raise ValueError("package compressed archive budget refused")
            total += metadata.st_size
            if total > total_bytes:
                raise ValueError("package compressed archive budget refused")
            archives.append(directory / entry.name)
    if not archives:
        raise ValueError("source-pinned fixture package closure refused")
    return sorted(archives)


@contextlib.contextmanager
def opened_package_archive(archive, *, maximum_bytes=128 * 1024 * 1024):
    if type(maximum_bytes) is not int or not 0 < maximum_bytes <= 128 * 1024 * 1024:
        raise ValueError("package compressed archive budget refused")
    # The held original inode is shared by digest, control and data decoding.
    # Change detection is NOT an external-writer barrier or a source seal.
    fields = ("st_dev", "st_ino", "st_mode", "st_uid", "st_gid", "st_nlink",
              "st_size", "st_mtime_ns", "st_ctime_ns")
    with contextlib.ExitStack() as owned:
        # A collected pathname can be replaced before acquisition. Nonblocking
        # open reaches the held-inode checks even for a FIFO with no writer.
        descriptor = os.open(archive, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW | os.O_CLOEXEC)
        owned.callback(os.close, descriptor)
        metadata = os.fstat(descriptor)
        if (not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.geteuid()
                or not 0 < metadata.st_size <= maximum_bytes):
            raise ValueError("package compressed archive budget refused")
        identity = tuple(getattr(metadata, field) for field in fields)
        digest, offset = hashlib.sha256(), 0
        while offset < metadata.st_size:
            data = os.pread(descriptor, min(1024 * 1024, metadata.st_size - offset), offset)
            if not data:
                raise ValueError("source-pinned fixture archive changed")
            digest.update(data)
            offset += len(data)
        if (os.pread(descriptor, 1, metadata.st_size)
                or tuple(getattr(os.fstat(descriptor), field) for field in fields) != identity):
            raise ValueError("source-pinned fixture archive changed")
        yield descriptor, digest.hexdigest(), metadata.st_size, identity
        if tuple(getattr(os.fstat(descriptor), field) for field in fields) != identity:
            raise ValueError("source-pinned fixture archive changed")


def signed_package_record(archive, base, options, arch, pins, digest, size):
    # A basename is ONLY an untrusted selector for authenticated private APT
    # metadata; it never establishes Package/Version/Architecture or identity.
    selector = archive.name.split("_", 1)[0]
    if re.fullmatch(r"[a-z0-9][a-z0-9+.-]{0,254}", selector) is None:
        raise ValueError("source-pinned fixture archive selector refused")
    metadata = call(["apt-cache", *options, "show", selector], cwd=base)
    candidates = []
    for paragraph in metadata.split("\n\n"):
        candidate = dict(line.split(": ", 1) for line in paragraph.splitlines()
                         if line and not line.startswith(" ") and ": " in line)
        if (candidate.get("Package") == selector and candidate.get("Architecture") in (arch, "all")
                and candidate.get("Origin") == "Ubuntu" and candidate.get("SHA256") == digest
                and candidate.get("Size") == str(size)):
            candidates.append(candidate)
    if len(candidates) != 1:
        raise ValueError("source-pinned fixture signed archive digest refused")
    record = candidates[0]
    if (not record.get("Version") or not record.get("Filename")
            or (selector in pins and record["Version"] != pins[selector])):
        raise ValueError("source-pinned fixture package identity refused")
    return record


def package_control_fields(archive, descriptor):
    # Let maintained dpkg parse control fields, but kernel-bound its real stdout
    # before capture. Internal control inflation still needs separate admission.
    with tempfile.TemporaryFile(dir=archive.parent) as output:
        # The maintained reader can spool the whole control tar before printing
        # fields. Bound that physical work separately from captured field bytes.
        decode_package_payload(archive, output, 4 * 1024 * 1024, descriptor=descriptor, control_fields=True)
        if output.tell() > 64 * 1024:
            raise ValueError("source-pinned fixture package control refused")
        output.seek(0)
        text = output.read(64 * 1024 + 1).decode("utf-8", errors="strict")
    record = {}
    for line in text.splitlines():
        if ": " not in line:
            raise ValueError("source-pinned fixture package control refused")
        key, value = line.split(": ", 1)
        if key not in ("Package", "Version", "Architecture") or key in record or not 0 < len(value.encode()) <= 4096:
            raise ValueError("source-pinned fixture package control refused")
        record[key] = value
    if set(record) != {"Package", "Version", "Architecture"}:
        raise ValueError("source-pinned fixture package control refused")
    return record


def decode_package_payload(archive, payload, limit, *, descriptor=None, control_fields=False):
    # One local owner must retain its child until group termination. An ignored
    # SIGCHLD or an external handler could auto-reap it and invalidate the PGID.
    if signal.getsignal(signal.SIGCHLD) != signal.SIG_DFL:
        raise RuntimeError("package decoder child ownership refused")
    # The kernel bounds output before write, including decoder subprocesses.
    # Fixed exact executable identities, no PATH-selected borrowed decoder.
    argv = ["/usr/bin/prlimit"]
    for name, kind, cap in (("fsize", resource.RLIMIT_FSIZE, limit),
                            ("as", resource.RLIMIT_AS, 256 * 1024 * 1024),
                            ("cpu", resource.RLIMIT_CPU, 30), ("nofile", resource.RLIMIT_NOFILE, 32),
                            ("core", resource.RLIMIT_CORE, 0)):
        inherited = [value for value in resource.getrlimit(kind) if value != resource.RLIM_INFINITY]
        actual = min([cap, *inherited])
        argv.append("--" + name + "=" + str(actual) + ":" + str(actual))
    source = str(archive) if descriptor is None else "/proc/self/fd/" + str(descriptor)
    argv += ["/usr/bin/dpkg-deb"]
    argv += (["-f", source, "Package", "Version", "Architecture"] if control_fields else ["--fsys-tarfile", source])
    # dpkg's control reader can use intermediate files. Keep those in one owned
    # private directory rather than its ambient OS temporary-file fallback.
    with tempfile.TemporaryDirectory(prefix="package-decode-", dir=archive.parent) as temporary:
        process = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=payload, stderr=subprocess.DEVNULL, start_new_session=True,
                                   pass_fds=() if descriptor is None else (descriptor,),
                                   env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C.UTF-8", "TMPDIR": temporary})
        try:
            deadline = time.monotonic() + 30
            # WNOWAIT observes completion WITHOUT releasing the leader PID. Do not
            # use Popen.wait/poll here: wait's KeyboardInterrupt path can reap before
            # re-raising, including interruption between waitpid and bookkeeping.
            while os.waitid(os.P_PID, process.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT) is None:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise subprocess.TimeoutExpired(argv, 30)
                time.sleep(min(0.01, remaining))
        except ChildProcessError as error:
            # A lost child reservation is not permission to signal the numeric PGID.
            raise RuntimeError("package decoder ownership unavailable") from error
        except BaseException:
            # Defer caller interruption until the retained leader is reaped;
            # a pending raising SIGTERM must not interrupt this owned cleanup.
            previous = signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGINT, signal.SIGTERM})
            try:
                # No wait/poll/reap has occurred in this phase; even an exited leader
                # remains our zombie and reserves its original PID/group identity.
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    # No signalable group was found; still reap the retained
                    # leader below. Other signal errors must propagate.
                    pass
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired as error:
                    raise RuntimeError("package decoder cleanup unavailable") from error
            finally:
                signal.pthread_sigmask(signal.SIG_SETMASK, previous)
            raise
        # The reaping phase is OUTSIDE the group-signalling handler. An interrupt
        # after actual waitpid has released identity must never re-enter that handler.
        try:
            status = process.wait(timeout=5)
        except subprocess.TimeoutExpired as error:
            raise RuntimeError("package decoder cleanup unavailable") from error
        if status or payload.tell() > limit:
            raise ValueError("source-pinned fixture package payload refused")


def extract_deb(archive, root, budget=None, *, descriptor=None):
    class PackageArchive(tarfile.TarFile):
        def _extract_member(self, member, targetpath, set_attrs=True, numeric_owner=False, **extraction_args):
            # Maintained makelink can recurse here with an ARCHIVED target at a
            # DIFFERENT path after EEXIST/missing-target copy fallback. Filter
            # the actual type/link/metadata at that destination BEFORE even an
            # implicit parent, symlink unlink, file truncate or attribute write.
            relative = str(pathlib.Path(targetpath).relative_to(root))
            actual = self._get_extract_tarinfo(
                member, lambda entry, path: tarfile.data_filter(entry.replace(name=relative), path), str(root))
            # Maintained security updates return (filtered, original) and pass
            # filter_function/extraction_root through recursive extraction.
            # Preserve that context; never retry with a weaker/unfiltered API.
            if isinstance(actual, tuple):
                actual, _ = actual
            budget.reserve_output(root, actual, self)
            validate_file_collision(actual)
            # Archive-relative link lookup must retain the original source
            # name/offset; only destination admission uses the relocated name.
            actual.name = member.name
            super()._extract_member(actual, targetpath, set_attrs, numeric_owner, **extraction_args)

    # Check/normalize every payload entry before extraction. Absolute in-root
    # Debian aliases become equivalent relative aliases; they can never cause
    # the host extractor to follow an absolute target outside this private root.
    with tempfile.TemporaryFile(dir=archive.parent) as payload:
        if budget is None:
            budget = PackageExtractionBudget()
        limit = min(budget.payload_bytes, budget.remaining_payload_bytes)
        if limit <= 0:
            raise ValueError("package aggregate extraction budget refused")
        before = os.fstat(descriptor) if descriptor is not None else None
        decode_package_payload(archive, payload, limit, descriptor=descriptor)
        if before is not None:
            after = os.fstat(descriptor)
            if any(getattr(before, field) != getattr(after, field) for field in
                   ("st_dev", "st_ino", "st_size", "st_mtime_ns", "st_ctime_ns")):
                raise ValueError("source-pinned fixture archive changed")
        budget.remaining_payload_bytes -= payload.tell()
        payload.seek(0)
        with bounded_archive(payload, headers=200001, member_bytes=512 * 1024 * 1024,
                             entry_error="source-pinned fixture package entry budget refused",
                             package_budget=budget, archive_class=PackageArchive) as stream:
            members = []
            raw_members = 0
            # getmembers() allocates the entire untrusted header list before
            # returning. Preserve 50,000 payload entries plus one ordinary
            # root header, but never let skipped root headers evade the cap.
            for member in stream:
                if raw_members == 50001:
                    raise ValueError("source-pinned fixture package entry budget refused")
                raw_members += 1
                if member.isdir() and pathlib.PurePosixPath(member.name) == pathlib.PurePosixPath("."):
                    continue
                if len(members) == 50000:
                    raise ValueError("source-pinned fixture package entry budget refused")
                members.append(member)
            budget.reserve(members)
            def validate_file_collision(member):
                destination = root / member.name
                if (member.isfile() or member.islnk()) and (destination.is_symlink() or destination.exists()):
                    if destination.is_symlink() or not destination.is_file():
                        raise ValueError("source-pinned fixture package file collision refused")
                    digest = hashlib.sha256()
                    with stream.extractfile(member) as source:
                        # EEXIST sends maintained hardlink extraction through
                        # its archived-target copy fallback. Validate those
                        # actual bytes, not the hardlink header's zero size.
                        size = source.seek(0, os.SEEK_END) if member.islnk() else member.size
                        if destination.stat().st_size != size:
                            raise ValueError("source-pinned fixture package file collision refused")
                        source.seek(0)
                        for data in iter(lambda: source.read(1024 * 1024), b""):
                            digest.update(data)
                    if digest.hexdigest() != sha(destination):
                        raise ValueError("source-pinned fixture package file collision refused")
            for member in members:
                relative = pathlib.PurePosixPath(member.name)
                if relative.is_absolute() or ".." in relative.parts or not (member.isfile() or member.isdir() or member.issym() or member.islnk()):
                    raise ValueError("source-pinned fixture package entry refused")
                destination = root / relative
                if not destination.parent.resolve().is_relative_to(root):
                    raise ValueError("source-pinned fixture package parent escaped")
                if member.issym() and member.linkname.startswith("/"):
                    member.linkname = os.path.relpath(root / member.linkname.lstrip("/"), destination.parent)
                if member.issym():
                    target = destination.parent / member.linkname
                    if not target.resolve().is_relative_to(root):
                        raise ValueError("source-pinned fixture package alias escaped")
                if member.isfile():
                    validate_file_collision(member)
            # Preserve maintained extraction and delayed directory attributes.
            # The actual extraction-entry guard reserves after preceding writes,
            # including recursive link fallbacks omitted by a top-level iterator.
            stream.extractall(root, members=members, filter="data")


def required_build_inputs(root, native):
    # Source-required programs are not implied by a satisfied package Depends
    # graph. Check actual contained executable bytes before downloaded source
    # runs, including configure's /bin/sh and its signed Dash realization.
    records = {}
    multiarch = {"x86_64": "x86_64-linux-gnu", "aarch64": "aarch64-linux-gnu"}[native]
    compiler_private = "usr/libexec/gcc/" + multiarch
    for name in ("bin/sh", "bin/bash", "usr/bin/env", "usr/bin/cc", "usr/bin/c++",
                 "usr/bin/make", "usr/bin/ninja", "usr/bin/python3", "usr/bin/pkg-config",
                 "usr/bin/grep", "usr/bin/sed", "usr/bin/awk", "usr/bin/find", "usr/bin/ld", "usr/bin/bzip2",
                 "usr/bin/diff", "usr/bin/expr", "usr/bin/tr", "usr/bin/date", "usr/bin/dirname", "usr/bin/basename",
                 "usr/bin/rm", "usr/bin/mkdir", "usr/bin/ln", "usr/bin/mv", "usr/bin/cat", "usr/bin/chmod",
                 "usr/bin/sort", "usr/bin/nm", "usr/bin/ar", "usr/bin/as",
                 compiler_private + "/13/cc1", compiler_private + "/13/collect2"):
        path = root / name
        try:
            actual = path.resolve(strict=True)
        except (OSError, RuntimeError) as error:
            raise ValueError("required private build program missing: " + name) from error
        if not actual.is_relative_to(root) or not actual.is_file() or not (actual.stat().st_mode & 0o111):
            raise ValueError("required private build program escaped or refused: " + name)
        with actual.open("rb") as stream:
            verify_elf_header(stream.read(64), native)
        records[name] = {"file": str(actual.relative_to(root)), "sha256": sha(actual),
                         "mode": stat.S_IMODE(actual.stat().st_mode)}
    if (root / "bin/sh").resolve(strict=True) != root / "usr/bin/dash":
        raise ValueError("signed private Dash interpreter realization required")
    return records


def usrmerge_layout(root, arch):
    if arch not in ("amd64", "arm64"):
        raise ValueError("private usrmerge architecture refused")
    # x86's declared ELF interpreter needs lib64; ARM does not acquire a
    # synthetic dangling alias when its signed inputs supply no such directory.
    names = ["bin", "sbin", "lib"]
    if arch == "amd64" or os.path.lexists(root / "usr/lib64") or os.path.lexists(root / "lib64"):
        names.append("lib64")
    for name in names:
        target = root / "usr" / name
        try:
            canonical = target.resolve(strict=True)
        except (OSError, RuntimeError) as error:
            raise ValueError("required private usrmerge target missing") from error
        if not canonical.is_relative_to(root) or not canonical.is_dir():
            raise ValueError("required private usrmerge target escaped or refused")
        path = root / name
        if os.path.lexists(path) and (not path.is_symlink() or path.resolve(strict=True) != canonical):
            raise ValueError("private usrmerge alias refused")
    aliases = {}
    for name in names:
        path = root / name
        if not os.path.lexists(path):
            path.symlink_to("usr/" + name)
        aliases[name] = os.readlink(path)
    return aliases


def provision(base, arch, multiarch, origin):
    keyring = pathlib.Path("/usr/share/keyrings/ubuntu-archive-keyring.gpg")
    if not keyring.is_file() or keyring.is_symlink():
        raise ValueError("Ubuntu archive signing root required")
    for name in ("state/lists/partial", "cache/archives/partial", "logs", "runtime"):
        (base / name).mkdir(parents=True, mode=0o700)
    (base / "status").write_text("")
    (base / "preferences").write_text("Package: *\nPin: release a=noble\nPin-Priority: 1001\n")
    if origin != SNAPSHOT_ORIGIN:
        raise ValueError("explicit frozen Ubuntu snapshot origin refused")
    private_apt_config(base, arch)
    shutil.copyfile(keyring, base / "ubuntu-archive-keyring.gpg")
    signing_root = base / "ubuntu-archive-keyring.gpg"
    (base / "sources.list").write_text("".join(
        f"deb [arch={arch} signed-by={signing_root}] {origin} {suite} main universe\n"
        for suite in ("noble", "noble-updates", "noble-security")))
    settings = {"Dir::Etc::sourcelist": str(base / "sources.list"), "Dir::Etc::sourceparts": "-",
                "Dir::State": str(base / "state"), "Dir::State::status": str(base / "status"),
                "Dir::Cache": str(base / "cache"), "Dir::Cache::pkgcache": "", "Dir::Cache::srcpkgcache": "",
                "Dir::Log": str(base / "logs"), "APT::Architecture": arch, "APT::Architectures": arch,
                "Dir::Etc::preferences": str(base / "preferences"), "Dir::Etc::preferencesparts": "-",
                "APT::Sandbox::User": pwd.getpwuid(os.geteuid()).pw_name, "Acquire::Languages": "none",
                "Acquire::GzipIndexes": "true", "Acquire::AllowInsecureRepositories": "false",
                "APT::Get::AllowUnauthenticated": "false", "APT::Update::Error-Mode": "any"}
    options = [item for key, value in settings.items() for item in ("-o", key + "=" + value)]
    call(["apt-get", *options, "update"], cwd=base)
    pins = {**SEEDS, **{name: MIT for name in KERBEROS}}
    pins.update({"libsasl2-2": CYRUS, "libsasl2-modules-gssapi-mit": CYRUS, "libgnutls30t64": GNUTLS,
                 "libgnutls-openssl27t64": GNUTLS, "libgnutls-dane0t64": GNUTLS})
    selectors = [name + "=" + pins[name] if name in pins else name for name in REQUIRED]
    selectors += [name + "=" + pins[name] for name in ("libgnutls-openssl27t64", "libgnutls-dane0t64")]

    # Resolve the complete Depends/Pre-Depends closure with an empty private
    # status, rather than guessing just the DSOs seen on an ambient host.
    call(["apt-get", *options, "--download-only", "--yes", "--no-install-recommends", "install", *selectors], cwd=base)
    packages = {}
    root = base / "runtime"
    archives = collect_package_archives(base / "cache/archives")
    extraction_budget = PackageExtractionBudget()
    extraction_budget.reserve_future_outputs(root)
    compressed_remaining = 512 * 1024 * 1024
    for archive in archives:
        with opened_package_archive(archive, maximum_bytes=min(128 * 1024 * 1024, compressed_remaining)) as (descriptor, digest, size, identity):
            compressed_remaining -= size
            candidate = signed_package_record(archive, base, options, arch, pins, digest, size)
            record = package_control_fields(archive, descriptor)
            name, version, package_arch = record["Package"], record["Version"], record["Architecture"]
            if (name in packages or any(record[field] != candidate[field] for field in
                                        ("Package", "Version", "Architecture"))):
                raise ValueError("source-pinned fixture package identity refused")
            if tuple(getattr(os.fstat(descriptor), field) for field in
                     ("st_dev", "st_ino", "st_mode", "st_uid", "st_gid", "st_nlink",
                      "st_size", "st_mtime_ns", "st_ctime_ns")) != identity:
                raise ValueError("source-pinned fixture archive changed")
            extract_deb(archive, root, extraction_budget, descriptor=descriptor)
            packages[name] = {"version": version, "architecture": package_arch, "archiveSha256": digest,
                              "archiveSizeBytes": size, "repositoryPath": candidate["Filename"],
                              "depends": candidate.get("Depends", ""),
                              "preDepends": candidate.get("Pre-Depends", ""),
                              "provides": candidate.get("Provides", "")}
    if not set(REQUIRED).issubset(packages):
        raise ValueError("source-pinned fixture dependency closure incomplete")
    # Debian maintainer scripts never run. The reproducible usrmerge and compiler
    # aliases below are explicit producer transformations, recorded as aliases.
    layout = usrmerge_layout(root, arch)
    for path in root.rglob("*"):
        if path.is_symlink() and os.readlink(path).startswith("/"):
            target = root / os.readlink(path).lstrip("/")
            path.unlink()
            path.symlink_to(os.path.relpath(target, path.parent))
    for name, target in (("cc", "gcc"), ("c++", "g++"), ("awk", "gawk"), ("pkg-config", "pkgconf")):
        path = root / "usr/bin" / name
        if not os.path.lexists(path):
            path.symlink_to(target)
    # Explicit replacements for maintainer-generated, contained public aliases.
    for name, target in (("usr/sbin/rmt", "rmt-tar"), ("etc/localtime", "../usr/share/zoneinfo/Etc/UTC")):
        path = root / name
        if not os.path.lexists(path):
            path.symlink_to(target)
    ca_bundle = root / "etc/ssl/certs/ca-certificates.crt"
    if not ca_bundle.exists():
        certificates = sorted((root / "usr/share/ca-certificates").rglob("*.crt"))
        if not certificates:
            raise ValueError("signed public CA input bundle missing")
        if sum(path.stat().st_size for path in certificates) > 128 * 1024 * 1024:
            raise ValueError("signed public CA output budget refused")
        ca_bundle.parent.mkdir(parents=True, exist_ok=True)
        with ca_bundle.open("xb") as output:
            copied = 0
            for path in certificates:
                with path.open("rb") as source:
                    for data in iter(lambda: source.read(1024 * 1024), b""):
                        copied += len(data)
                        if copied > 128 * 1024 * 1024:
                            raise ValueError("signed public CA output budget refused")
                        output.write(data)
    for name in ("proc", "dev", "run", "repo", "contract", "build", "source", "tmp"):
        (root / name).mkdir(exist_ok=True)
    return {"mitVersion": MIT, "multiarch": multiarch, "architecture": arch,
            "signedIndexOrigin": origin, "snapshot": SNAPSHOT, "suite": "noble", "packages": packages,
            "signingRootSha256": sha(signing_root),
            "requiredBuildInputs": required_build_inputs(root, {"amd64": "x86_64", "arm64": "aarch64"}[arch]),
            "bootstrapInputs": {str(path): sha(path.resolve(strict=True)) for path in
                                (keyring, pathlib.Path("/usr/bin/apt-get"), pathlib.Path("/usr/bin/apt-cache"),
                                 pathlib.Path("/usr/bin/gpgv"), pathlib.Path("/usr/bin/dpkg-deb"), pathlib.Path("/usr/bin/prlimit"),
                                 pathlib.Path("/usr/lib/apt/apt-helper"))},
            "transformations": ["contained absolute package aliases", {"usrmergeLayout": layout}, "archive-provided Dash sh alias", "compiler aliases",
                                "rmt alias", "UTC alias", "signed public CA concatenation"],
            "signedIndexFiles": {str(p.relative_to(base)): sha(p) for p in sorted((base / "state/lists").glob("*"))
                                 if p.is_file() and not p.is_symlink() and (p.name.endswith("InRelease") or "_Packages" in p.name)}}


def extract_source(archive, source):
    if archive.is_symlink() or sha(archive) != QEMU_SHA256:
        raise ValueError("source-pinned QEMU archive digest refused")
    with lzma.open(archive, "rb") as decoded, bounded_archive(
            decoded, headers=QEMU_MEMBER_COUNT * 4 + 1, member_bytes=QEMU_MEMBER_BYTES,
            entry_error="source-pinned QEMU archive header budget refused") as stream:
        members = []
        for member in stream:
            if len(members) == QEMU_MEMBER_COUNT:
                raise ValueError("source-pinned QEMU archive budget refused")
            members.append(member)
        # The pinned official release was independently inspected: exact
        # cardinality/size/epoch are part of this source admission profile.
        # Retain finite budgets and fail any other shape, even after hashing.
        if (len(members) != QEMU_MEMBER_COUNT or sum(m.size for m in members) != QEMU_MEMBER_BYTES
                or QEMU_MEMBER_BYTES > 1024 * 1024 * 1024
                or max(m.mtime for m in members) != QEMU_SOURCE_EPOCH):
            raise ValueError("source-pinned QEMU archive budget refused")
        selected = []
        for member in members:
            source_member(member.name)
            if not (member.isfile() or member.isdir() or member.issym()):
                raise ValueError("source-pinned QEMU archive type refused")
            if member.issym() and (member.name, member.linkname) == EXCLUDED_SOURCE_ALIAS:
                continue
            if member.issym() and member.linkname.startswith("/"):
                raise ValueError("source-pinned QEMU absolute alias refused")
            selected.append(member)
        stream.extractall(source.parent, members=selected, filter="data")
        epoch = max(m.mtime for m in members)
    if sha(source / "ui/vnc-auth-sasl.c") != VNC_SHA256:
        raise ValueError("source-pinned QEMU VNC source refused")
    for name, digest in FIRMWARE.items():
        if sha(source / "pc-bios" / name) != digest:
            raise ValueError("source-pinned QEMU firmware refused")
    return epoch


def build(base, source, epoch, arch):
    root, output = base / "runtime", base / "build"
    output.mkdir(mode=0o700)
    # No installation, user-only build, no downloaded subprojects or host DSOs.
    # Each build uses its own mapped path but the same deterministic prefix.
    script = '''set -euo pipefail
mount --bind "$1" "$1"
mount -o remount,bind,ro "$1"
mount --bind "$2" "$1/build"
mount --bind "$3" "$1/source"
mount -o remount,bind,ro "$1/source"
mount -t proc proc "$1/proc"
mount -t tmpfs -o size=67108864,nr_inodes=256,mode=1777 none "$1/tmp"
mount -t tmpfs -o size=1048576,mode=0755 none "$1/dev"
mknod -m 0666 "$1/dev/null" c 1 3
mknod -m 0666 "$1/dev/urandom" c 1 9
ln -s /proc/self/fd "$1/dev/fd"
for attempt in first second; do
  mkdir "$2/$attempt"
  chown "$4:$5" "$2/$attempt"
  /usr/sbin/chroot --userspec="$4:$5" "$1" /usr/bin/env -i PATH=/usr/bin:/bin HOME=/tmp LANG=C.UTF-8 TZ=UTC SOURCE_DATE_EPOCH="$6" CFLAGS="-O2 -g0 -ffile-prefix-map=/build/$attempt=. -ffile-prefix-map=/source=../source" CXXFLAGS="-O2 -g0 -ffile-prefix-map=/build/$attempt=. -ffile-prefix-map=/source=../source" /bin/bash -c 'set -euo pipefail; cd "/build/$1"; shift; /source/configure "$@"; /usr/bin/ninja -j 1 qemu-system-x86_64' bash "$attempt" "${@:7}"
done
'''
    result = subprocess.run(["sudo", "timeout", "--signal=TERM", "--kill-after=5s", "2400s", "unshare", "--mount", "--net", "--pid", "--fork", "--kill-child", "--propagation", "private",
                             "bash", "-c", script, "bash", str(root), str(output), str(source), str(os.geteuid()), str(os.getegid()), str(epoch), *CONFIGURE],
                            stdout=(base / "build.log").open("w"), stderr=subprocess.STDOUT, timeout=2410,
                            env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C.UTF-8"})
    if result.returncode:
        raise RuntimeError("source-pinned QEMU build refused; retain build.log")
    first, second = [output / attempt / "qemu-system-x86_64" for attempt in ("first", "second")]
    for binary in (first, second):
        if (binary.is_symlink() or not binary.is_file() or not binary.resolve(strict=True).is_relative_to(output)
                or not 64 <= binary.stat().st_size <= 128 * 1024 * 1024):
            raise ValueError("source-pinned QEMU native output refused")
        with binary.open("rb") as stream:
            verify_elf_header(stream.read(64), arch)
    if sha(first) != sha(second):
        raise ValueError("source-pinned QEMU independent builds differ")
    # Retain both original streams as data, even when later inventory fails.
    # Hash equality is necessary but not independent pin/runtime acceptance.
    evidence = base / "public-evidence"
    evidence.mkdir(mode=0o700, exist_ok=True)
    outputs = {}
    for attempt, binary in (("first", first), ("second", second)):
        retained = evidence / (attempt + "-qemu-system-x86_64.elf")
        with retained.open("xb") as destination_stream, binary.open("rb") as source_stream:
            shutil.copyfileobj(source_stream, destination_stream)
        retained.chmod(0o600)
        if sha(retained) != sha(binary) or retained.stat().st_size != binary.stat().st_size:
            raise ValueError("public native output retention mismatch")
        outputs[attempt] = {"path": str(retained.relative_to(base)), "sha256": sha(retained),
                            "sizeBytes": retained.stat().st_size}
    destination = root / "usr/bin/qemu-system-x86_64"
    shutil.copyfile(first, destination)
    destination.chmod(0o755)
    firmware = root / "usr/share/seabios"
    firmware.mkdir(parents=True, exist_ok=True)
    for name, destination_name in (("bios-256k.bin", "bios.bin"), ("vgabios-stdvga.bin", "vgabios-stdvga.bin")):
        shutil.copyfile(source / "pc-bios" / name, firmware / destination_name)
    (root / "usr/share/qemu").mkdir(exist_ok=True)
    return {"version": "9.2.0", "sourceArchiveSha256": QEMU_SHA256, "vncSourceSha256": VNC_SHA256,
            "firmware": FIRMWARE, "configure": CONFIGURE, "sourceDateEpoch": epoch,
            "sourceAdmission": {"memberCount": QEMU_MEMBER_COUNT, "memberBytes": QEMU_MEMBER_BYTES,
                                "excludedNonbuildAlias": list(EXCLUDED_SOURCE_ALIAS)},

            "nativeArchitecture": arch, "binarySha256": sha(first), "secondBuildSha256": sha(second),
            "retainedNativeOutputs": outputs,
            "recipeSha256": sha(pathlib.Path(__file__)), "target": "x86_64-softmmu"}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-archive", type=pathlib.Path)
    args = parser.parse_args()
    native = platform.machine()
    arch, multiarch = {"x86_64": ("amd64", "x86_64-linux-gnu"),
                       "aarch64": ("arm64", "aarch64-linux-gnu")}[native]
    origin = SNAPSHOT_ORIGIN
    parent = REPO / "crates/target/qemu-full-fixture"
    parent.mkdir(parents=True, exist_ok=True)
    if parent.is_symlink() or parent.resolve() != parent or not call(["git", "check-ignore", str(parent)], cwd=REPO).strip():
        raise ValueError("source-pinned fixture work root refused")
    base = pathlib.Path(tempfile.mkdtemp(prefix="signed-noble-", dir=parent))
    base.chmod(0o700)
    stage, manifest = "provision", None
    try:
        manifest = provision(base, arch, multiarch, origin)
        # Persist complete package/index linkage and original downloaded archives
        # before the first fallible source extraction or compiler invocation.
        stage = "archive-custody"
        retain_public_inputs(base, "provision-complete", manifest)
        stage = "source"
        if args.source_archive and args.source_archive.is_symlink():
            raise ValueError("source archive alias refused")
        archive = args.source_archive.resolve(strict=True) if args.source_archive else base / "qemu-9.2.0.tar.xz"
        if not args.source_archive:
            call(["bash", REPO / ".github/scripts/download-verified.sh", "https://download.qemu.org/qemu-9.2.0.tar.xz", QEMU_SHA256, archive])
        source = base / "qemu-9.2.0"
        epoch = extract_source(archive, source)
        manifest["fullQemuProvider"] = "source-pinned-private-noble-v2"
        stage = "build"
        manifest["qemuBuild"] = build(base, source, epoch, native)
        stage = "inventory"
        manifest["producer"] = {"head": call(["git", "rev-parse", "HEAD"], cwd=REPO).strip(),
                                "worktreeDirty": bool(call(["git", "status", "--porcelain"], cwd=REPO).strip()),
                                "ownerUid": os.geteuid(), "nativeArchitecture": native,
                                "buildLogSha256": sha(base / "build.log")}
        manifest["immutableTree"], manifest["runtimeInventorySha256"] = inventory(base / "runtime")
        manifest["files"] = {name: row["sha256"] for name, row in manifest["immutableTree"]["nodes"].items()
                             if row["kind"] == "regular"}
        manifest["aliases"] = {name: row["target"] for name, row in manifest["immutableTree"]["nodes"].items()
                               if row["kind"] == "alias"}
        manifest["inputMeasurementSourceSha256"] = sha(REPO / "crates/rfb-client/tests/fixtures/qemu_gssapi.py")
        measurement_python = pathlib.Path(sys.executable).resolve(strict=True)
        manifest["bootstrapInputs"][str(measurement_python)] = sha(measurement_python)
        manifest["inputClosureSha256"] = hashlib.sha256(json.dumps(
            {name: manifest[name] for name in ("signedIndexFiles", "bootstrapInputs", "transformations", "signingRootSha256", "requiredBuildInputs", "inputMeasurementSourceSha256")},
            sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        manifest["packageLockSha256"] = hashlib.sha256(json.dumps(manifest["packages"], sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        stage = "provider"
        # Detached public descriptor: no provider omission or self-hash cycle
        # inside the complete runtime tree. External reviewed pins remain empty.
        contract = base / "contract"
        contract.mkdir(mode=0o700)
        with (contract / "provider.json").open("x") as provider:
            provider.write(json.dumps(manifest, indent=2, ensure_ascii=True) + "\n")
        (contract / "provider.json").chmod(0o600)
        tree, digest = inventory(contract)
        with (base / "public-evidence/contract-inventory.json").open("x") as record:
            json.dump({"tree": tree, "treeSha256": digest, "measurementOnly": True,
                       "runtimeVerified": False, "attributionVerified": False}, record, ensure_ascii=True)
    except Exception:
        retain_public_inputs(base, stage + "-failed", manifest)
        raise
    print(base / "runtime")


if __name__ == "__main__":
    main()
