#!/usr/bin/env python3
"""Privately extract the exact signed Ubuntu Noble MIT acceptor/KDC fixture.

No installation, maintainer scripts, host apt/config edits or production inputs.
APT verifies Noble's signed indexes; every downloaded archive is checked against
that index and its package/version/architecture before dpkg-deb extraction.
"""
import hashlib
import json
import os
import pathlib
import platform
import pwd
import subprocess
import tempfile

REPO = pathlib.Path(__file__).resolve().parents[2]
MIT = "1.20.1-6ubuntu2"
KERBEROS = (
    "krb5-user", "krb5-kdc", "krb5-admin-server", "libgssapi-krb5-2",
    "libkrb5-3", "libk5crypto3", "libkrb5support0", "libkdb5-10t64",
    "libkadm5clnt-mit12", "libkadm5srv-mit12", "libgssrpc4t64",
)
SUPPORT = (
    "libcom-err2", "libss2", "libverto1t64", "libverto-libevent1t64",
    "libevent-2.1-7t64", "liblmdb0", "libkeyutils1", "libreadline8t64", "libtinfo6",
)


def call(argv, *, cwd=None, timeout=120):
    result = subprocess.run(argv, cwd=cwd, text=True, capture_output=True,
                            timeout=timeout, env={"PATH": os.environ["PATH"], "LANG": "C.UTF-8"})
    if result.returncode:
        raise RuntimeError("signed fixture provisioning refused: " + pathlib.Path(argv[0]).name)
    return result.stdout


def main():
    arch, multiarch, origin = {
        "x86_64": ("amd64", "x86_64-linux-gnu", "https://archive.ubuntu.com/ubuntu"),
        "aarch64": ("arm64", "aarch64-linux-gnu", "https://ports.ubuntu.com/ubuntu-ports"),
    }[platform.machine()]
    signing_root = pathlib.Path("/usr/share/keyrings/ubuntu-archive-keyring.gpg")
    assert signing_root.is_file() and not signing_root.is_symlink()
    parent = REPO / "crates/target/kerberos-peer-fixture"
    parent.mkdir(parents=True, exist_ok=True)
    assert parent.resolve() == parent and not parent.is_symlink()
    assert call(["git", "check-ignore", str(parent)], cwd=REPO).strip()
    base = pathlib.Path(tempfile.mkdtemp(prefix="signed-noble-", dir=parent))
    base.chmod(0o700)
    for name in ("state/lists/partial", "cache/archives/partial", "logs", "downloads", "runtime"):
        (base / name).mkdir(parents=True, mode=0o700)
    (base / "status").write_text("")
    (base / "sources.list").write_text(
        f"deb [arch={arch} signed-by={signing_root}] {origin} noble main universe\n")
    options = []
    settings = {
        "Dir::Etc::sourcelist": str(base / "sources.list"),
        "Dir::Etc::sourceparts": "-",
        "Dir::State": str(base / "state"),
        "Dir::State::status": str(base / "status"),
        "Dir::Cache": str(base / "cache"),
        "Dir::Cache::pkgcache": "",
        "Dir::Cache::srcpkgcache": "",
        "Dir::Log": str(base / "logs"),
        "APT::Architecture": arch,
        "APT::Architectures": arch,
        "APT::Sandbox::User": pwd.getpwuid(os.geteuid()).pw_name,
        "Acquire::Languages": "none",
        "Acquire::GzipIndexes": "true",
        "Acquire::AllowInsecureRepositories": "false",
        "APT::Get::AllowUnauthenticated": "false",
        "APT::Update::Error-Mode": "any",
    }
    for key, value in settings.items():
        options.extend(["-o", key + "=" + value])
    call(["apt-get", *options, "update"], cwd=base)
    packages = {}
    runtime = base / "runtime"
    for name in (*KERBEROS, *SUPPORT):
        selector = name + "=" + MIT if name in KERBEROS else name
        metadata = call(["apt-cache", *options, "show", selector], cwd=base)
        record = {}
        for line in metadata.split("\n\n", 1)[0].splitlines():
            if line and not line.startswith(" ") and ": " in line:
                key, value = line.split(": ", 1)
                record[key] = value
        assert record.get("Package") == name and record.get("Architecture") == arch, name
        assert record["Origin"] == "Ubuntu"
        version, digest = record["Version"], record["SHA256"]
        assert len(digest) == 64 and all(char in "0123456789abcdef" for char in digest)
        if name in KERBEROS:
            assert version == MIT and record.get("Source", name).split(" ", 1)[0] == "krb5"
        destination = base / "downloads" / name
        destination.mkdir(mode=0o700)
        call(["apt-get", *options, "download", name + "=" + version], cwd=destination)
        archives = list(destination.glob("*.deb"))
        assert len(archives) == 1 and not archives[0].is_symlink()
        archive = archives[0]
        assert hashlib.sha256(archive.read_bytes()).hexdigest() == digest
        fields = call(["dpkg-deb", "-f", str(archive), "Package", "Version", "Architecture"])
        assert fields.splitlines() == ["Package: " + name, "Version: " + version, "Architecture: " + arch]
        call(["dpkg-deb", "--extract", str(archive), str(runtime)])
        packages[name] = {"version": version, "architecture": arch, "archiveSha256": digest}
    files = {}
    for path in sorted(runtime.rglob("*")):
        if path.is_file() and not path.is_symlink():
            assert path.resolve().is_relative_to(runtime)
            files[str(path.relative_to(runtime))] = hashlib.sha256(path.read_bytes()).hexdigest()
    manifest = {
        "mitVersion": MIT, "multiarch": multiarch, "architecture": arch,
        "signedIndexOrigin": origin, "suite": "noble",
        "signingRootSha256": hashlib.sha256(signing_root.read_bytes()).hexdigest(),
        "packages": packages, "files": files,
    }
    (runtime / "provider.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(runtime)


if __name__ == "__main__":
    main()
