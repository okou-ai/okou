#!/usr/bin/env python3
"""Build QEMU9.2 twice in a private signed Noble native sysroot.

APT downloads only; no installation/maintainer script, host configuration or KDC.
A disposable mount/PID namespace confines the build; build commands run as the
ordinary owner with an empty environment. Runtime is a separate explicit mode.
"""
import argparse
import hashlib
import json
import os
import pathlib
import platform
import pwd
import shutil
import stat
import subprocess
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
            "libgnutls30t64", "bash", "dash", "coreutils", "grep", "sed", "gawk", "findutils", "iproute2",
            "make", "gcc", "g++", "gcc-13", "g++-13", "binutils", "libc6-dev", "pkgconf",
            "ninja-build", "python3", "python3-venv", "python3.12", "python3.12-venv", "libglib2.0-dev",
            "libpixman-1-dev", "libfdt-dev", "zlib1g-dev", "libgnutls28-dev", "libsasl2-dev", "openssl")
SEEDS = {"dash": "0.5.12-6ubuntu5", "gcc-13": "13.2.0-23ubuntu4", "g++-13": "13.2.0-23ubuntu4", "binutils": "2.42-4ubuntu2",
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
    with (evidence / (stage + ".json")).open("x") as output:
        json.dump(payload, output, indent=2)
        output.write("\n")


def sha(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for data in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(data)
    return digest.hexdigest()


def verify_elf_header(data, arch):
    if len(data) < 64 or data[:6] != b"\x7fELF\x02\x01" or int.from_bytes(data[18:20], "little") != {"x86_64": 62, "aarch64": 183}[arch]:
        raise ValueError("source-pinned fixture native ELF architecture refused")


def source_member(name):
    path = pathlib.PurePosixPath(name)
    if path.is_absolute() or ".." in path.parts or not path.parts or path.parts[0] != "qemu-9.2.0":
        raise ValueError("source-pinned fixture archive path refused")
    return pathlib.PurePosixPath(*path.parts[1:])


def inventory(root):
    files, aliases = {}, {}
    for path in sorted(root.rglob("*")):
        name = str(path.relative_to(root))
        if path.is_symlink():
            try:
                target = path.resolve(strict=True)
            except FileNotFoundError as error:
                # Some signed Debian packages ship dangling documentation or
                # non-C locale aliases. Preserve their exact declared identity,
                # never use them as executable/library/configuration inputs.
                if not name.startswith(("usr/share/doc/", "usr/share/man/", "usr/share/locale/")):
                    raise ValueError("source-pinned fixture dangling runtime alias refused") from error
                target = path.resolve(strict=False)
            except (OSError, RuntimeError) as error:
                raise ValueError("source-pinned fixture alias refused") from error
            if not target.is_relative_to(root):
                raise ValueError("source-pinned fixture alias escaped")
            aliases[name] = os.readlink(path)
        elif path.is_file():
            if not path.resolve(strict=True).is_relative_to(root):
                raise ValueError("source-pinned fixture file escaped")
            files[name] = sha(path)
        elif not path.is_dir():
            raise ValueError("source-pinned fixture special file refused")
    return files, aliases


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
    for name in ("bin/sh", "bin/bash", "usr/bin/env", "usr/bin/cc", "usr/bin/c++",
                 "usr/bin/make", "usr/bin/ninja", "usr/bin/python3", "usr/bin/pkg-config",
                 "usr/bin/grep", "usr/bin/sed", "usr/bin/awk", "usr/bin/find", "usr/bin/ld"):
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
    for name, target in (("bin", "usr/bin"), ("sbin", "usr/sbin"), ("lib", "usr/lib"), ("lib64", "usr/lib64")):
        path = root / name
        if not os.path.lexists(path):
            path.symlink_to(target)
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
    for name in ("proc", "dev", "run", "repo", "build", "source", "tmp"):
        (root / name).mkdir(exist_ok=True)
    return {"mitVersion": MIT, "multiarch": multiarch, "architecture": arch,
            "signedIndexOrigin": origin, "snapshot": SNAPSHOT, "suite": "noble", "packages": packages,
            "signingRootSha256": sha(signing_root),
            "requiredBuildInputs": required_build_inputs(root, {"amd64": "x86_64", "arm64": "aarch64"}[arch]),
            "bootstrapInputs": {str(path): sha(path.resolve(strict=True)) for path in
                                (keyring, pathlib.Path("/usr/bin/apt-get"), pathlib.Path("/usr/bin/apt-cache"),
                                 pathlib.Path("/usr/bin/gpgv"), pathlib.Path("/usr/bin/dpkg-deb"),
                                 pathlib.Path("/usr/lib/apt/apt-helper"))},
            "transformations": ["contained absolute package aliases", "usrmerge", "archive-provided Dash sh alias", "compiler aliases",
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
        verify_elf_header(binary.read_bytes()[:64], arch)
    if sha(first) != sha(second):
        raise ValueError("source-pinned QEMU independent builds differ")
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
        # Persist the resolved complete package/index linkage before the first
        # fallible source extraction or compiler invocation.
        retain_public_inputs(base, "provision-complete", manifest)
        stage = "source"
        if args.source_archive and args.source_archive.is_symlink():
            raise ValueError("source archive alias refused")
        archive = args.source_archive.resolve(strict=True) if args.source_archive else base / "qemu-9.2.0.tar.xz"
        if not args.source_archive:
            call(["bash", REPO / ".github/scripts/download-verified.sh", "https://download.qemu.org/qemu-9.2.0.tar.xz", QEMU_SHA256, archive])
        source = base / "qemu-9.2.0"
        epoch = extract_source(archive, source)
        manifest["fullQemuProvider"] = "source-pinned-private-noble-v1"
        stage = "build"
        manifest["qemuBuild"] = build(base, source, epoch, native)
    except Exception:
        retain_public_inputs(base, stage + "-failed", manifest)
        raise
    manifest["files"], manifest["aliases"] = inventory(base / "runtime")
    manifest["runtimeInventorySha256"] = hashlib.sha256(json.dumps(
        {name: manifest[name] for name in ("files", "aliases")}, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    manifest["inputClosureSha256"] = hashlib.sha256(json.dumps(
        {name: manifest[name] for name in ("signedIndexFiles", "bootstrapInputs", "transformations", "signingRootSha256", "requiredBuildInputs")},
        sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    manifest["packageLockSha256"] = hashlib.sha256(json.dumps(manifest["packages"], sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    manifest["producer"] = {"head": call(["git", "rev-parse", "HEAD"], cwd=REPO).strip(),
                            "worktreeDirty": bool(call(["git", "status", "--porcelain"], cwd=REPO).strip()),
                            "ownerUid": os.geteuid(), "nativeArchitecture": native,
                            "buildLogSha256": sha(base / "build.log")}
    (base / "runtime/provider.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(base / "runtime")


if __name__ == "__main__":
    main()
