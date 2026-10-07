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
import os
import pathlib
import platform
import pwd
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile

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


def extract_deb(archive, root):
    # Check/normalize every payload entry before extraction. Absolute in-root
    # Debian aliases become equivalent relative aliases; they can never cause
    # the host extractor to follow an absolute target outside this private root.
    with tempfile.TemporaryFile(dir=archive.parent) as payload:
        result = subprocess.run(["dpkg-deb", "--fsys-tarfile", str(archive)], stdout=payload,
                                stderr=subprocess.PIPE, timeout=30)
        if result.returncode or payload.tell() > 512 * 1024 * 1024:
            raise ValueError("source-pinned fixture package payload refused")
        payload.seek(0)
        with tarfile.open(fileobj=payload, mode="r:") as stream:
            members = [member for member in stream.getmembers() if not (member.isdir() and pathlib.PurePosixPath(member.name) == pathlib.PurePosixPath("."))]
            if len(members) > 50000:
                raise ValueError("source-pinned fixture package entry budget refused")
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
                if member.isfile() and destination.exists():
                    if destination.is_symlink() or not destination.is_file() or hashlib.sha256(stream.extractfile(member).read()).hexdigest() != sha(destination):
                        raise ValueError("source-pinned fixture package file collision refused")
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
    archives = sorted((base / "cache/archives").glob("*.deb"))
    if not archives or len(archives) > 200:
        raise ValueError("source-pinned fixture package closure refused")
    for archive in archives:
        if archive.is_symlink() or not archive.is_file():
            raise ValueError("source-pinned fixture archive refused")
        fields = call(["dpkg-deb", "-f", archive, "Package", "Version", "Architecture"])
        record = dict(line.split(": ", 1) for line in fields.splitlines())
        name, version, package_arch = record["Package"], record["Version"], record["Architecture"]
        if package_arch not in (arch, "all") or name in packages or (name in pins and version != pins[name]):
            raise ValueError("source-pinned fixture package identity refused")
        metadata = call(["apt-cache", *options, "show", name + "=" + version], cwd=base)
        candidates = []
        for paragraph in metadata.split("\n\n"):
            candidate = dict(line.split(": ", 1) for line in paragraph.splitlines() if line and not line.startswith(" ") and ": " in line)
            if candidate.get("Architecture") == package_arch and candidate.get("Version") == version:
                candidates.append(candidate)
        if len(candidates) != 1 or candidates[0].get("Origin") != "Ubuntu" or sha(archive) != candidates[0]["SHA256"]:
            raise ValueError("source-pinned fixture signed archive digest refused")
        extract_deb(archive, root)
        packages[name] = {"version": version, "architecture": package_arch, "archiveSha256": sha(archive),
                          "archiveSizeBytes": archive.stat().st_size, "repositoryPath": candidates[0]["Filename"],
                          "depends": candidates[0].get("Depends", ""),
                          "preDepends": candidates[0].get("Pre-Depends", ""),
                          "provides": candidates[0].get("Provides", "")}
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
        ca_bundle.parent.mkdir(parents=True, exist_ok=True)
        ca_bundle.write_bytes(b"".join(path.read_bytes() for path in certificates))
    for name in ("proc", "dev", "run", "repo", "contract", "build", "source", "tmp"):
        (root / name).mkdir(exist_ok=True)
    return {"mitVersion": MIT, "multiarch": multiarch, "architecture": arch,
            "signedIndexOrigin": origin, "snapshot": SNAPSHOT, "suite": "noble", "packages": packages,
            "signingRootSha256": sha(signing_root),
            "requiredBuildInputs": required_build_inputs(root, {"amd64": "x86_64", "arm64": "aarch64"}[arch]),
            "bootstrapInputs": {str(path): sha(path.resolve(strict=True)) for path in
                                (keyring, pathlib.Path("/usr/bin/apt-get"), pathlib.Path("/usr/bin/apt-cache"),
                                 pathlib.Path("/usr/bin/gpgv"), pathlib.Path("/usr/bin/dpkg-deb"),
                                 pathlib.Path("/usr/lib/apt/apt-helper"))},
            "transformations": ["contained absolute package aliases", {"usrmergeLayout": layout}, "archive-provided Dash sh alias", "compiler aliases",
                                "rmt alias", "UTC alias", "signed public CA concatenation"],
            "signedIndexFiles": {str(p.relative_to(base)): sha(p) for p in sorted((base / "state/lists").glob("*"))
                                 if p.is_file() and not p.is_symlink() and (p.name.endswith("InRelease") or "_Packages" in p.name)}}


def extract_source(archive, source):
    if archive.is_symlink() or sha(archive) != QEMU_SHA256:
        raise ValueError("source-pinned QEMU archive digest refused")
    with tarfile.open(archive, "r:xz") as stream:
        members = stream.getmembers()
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
