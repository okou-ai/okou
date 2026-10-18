"""Split a customized, trusted template into a tool root and immutable runtime.

Runs in customize-rootfs.sh's private mount namespace while its image lock is
retained. Never consumes a live Guest filesystem or a user home.
"""

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

MOUNT = "/run/okou/runtime"
IDENTITY = "/etc/okou/runtime-build-id"


def run(*args):
    # readelf/dumpe2fs records are parsed below; Host locale must not change
    # dependency discovery or silently leave a writable-root interpreter.
    return subprocess.check_output(
        args, text=True, env={**os.environ, "LC_ALL": "C"}
    ).strip()


def split(root, output, identity, cli_version):
    root = root.resolve(strict=True)
    with tempfile.TemporaryDirectory(prefix=".okou-runtime-", dir=root) as temporary:
        payload = Path(temporary)
        payload.chmod(0o755)
        copied = set()
        queue = []

        def resolve(path):
            # Resolve absolute symlinks in the image's root, never the Host root.
            name = run("chroot", str(root), "realpath", "-e", "--", path)
            if not name.startswith("/") or ".." in Path(name).parts:
                raise ValueError(f"Invalid runtime source: {path}")
            return name

        def copy(path):
            name = resolve(path)
            if name in copied:
                return name
            copied.add(name)
            source = root / name.lstrip("/")
            target = payload / name.lstrip("/")
            target.parent.mkdir(parents=True, exist_ok=True)
            if source.is_dir():
                target.mkdir(exist_ok=True)
                for child in sorted(source.iterdir()):
                    child_name = copy(f"{name}/{child.name}")
                    if child.is_symlink():
                        link = target / child.name
                        if not link.exists():
                            link.symlink_to(
                                os.path.relpath(
                                    payload / child_name.lstrip("/"), link.parent
                                )
                            )
            else:
                shutil.copy2(source, target)
                with source.open("rb") as handle:
                    if handle.read(4) == b"\x7fELF":
                        queue.append(name)
            return name

        def alias(path, destination):
            target = payload / path.lstrip("/")
            target.parent.mkdir(parents=True, exist_ok=True)
            if target.is_symlink():
                target.unlink()
            target.symlink_to(
                os.path.relpath(payload / destination.lstrip("/"), target.parent)
            )

        for path in (
            "/usr/local/bin/claude",
            "/usr/bin/node",
            "/usr/local/bin/guest-agent",
            "/usr/local/bin/guest-tool-exec",
        ):
            actual = copy(path)
            if actual != path:
                alias(path, actual)
        codex_roots = [
            p
            for prefix in (
                "usr/lib/node_modules/@openai",
                "usr/local/lib/node_modules/@openai",
            )
            for p in (root / prefix).glob("codex*")
        ]
        if not codex_roots:
            raise ValueError("Official Codex package missing")
        for package in codex_roots:
            copy("/" + str(package.relative_to(root)))
        # Official npm releases have used both vendor and platform-package
        # directories. Select the sole installed ELF program from the copied
        # official package inventory, rather than guessing one old layout.
        codex_bins = []
        for path in payload.rglob("codex"):
            if path.is_file():
                with path.open("rb") as handle:
                    if handle.read(4) == b"\x7fELF":
                        codex_bins.append(path)
        if len(codex_bins) != 1:
            raise ValueError(
                f"Expected one native Codex payload, found {len(codex_bins)}"
            )
        alias("/usr/local/bin/codex", "/" + str(codex_bins[0].relative_to(payload)))
        codex_package = [p for p in codex_roots if p.name == "codex"]
        if len(codex_package) != 1:
            raise ValueError("Expected one official Codex package root")
        alias(
            "/usr/local/lib/okou-codex",
            "/" + str(codex_package[0].relative_to(root)),
        )
        if cli_version:
            cli = f"/usr/local/lib/okou-cli/{cli_version}"
            copy(cli + "/agent")
            copy(cli + "/package.json")
            copy("/usr/local/lib/okou-cli/installed.json")
            # No private Pi program remains in the ordinary CLI installation.
            shutil.rmtree(root / (cli + "/agent").lstrip("/"))
            (root / (cli + "/agent").lstrip("/")).symlink_to(MOUNT + cli + "/agent")
            alias("/usr/local/lib/okou-agent", cli + "/agent")

        # NSS and gconv are dynamic glibc inputs beyond DT_NEEDED. Trust and
        # locale data are explicitly inventoried rather than inferred from a trace.
        for path in (
            "/etc/ssl/certs",
            "/etc/ssl/openssl.cnf",
            "/etc/nsswitch.conf",
            "/etc/claude-code",
            "/etc/codex",
            "/usr/lib/locale/C.utf8",
        ):
            copy(path)
        for pattern in (
            "usr/lib/*-linux-gnu/libnss_*.so.2",
            "usr/lib/*-linux-gnu/gconv",
        ):
            for path in sorted(root.glob(pattern)):
                copy("/" + str(path.relative_to(root)))
        library_dirs = ["/usr/lib", "/usr/local/lib"]
        library_dirs += [
            "/" + str(p.relative_to(root))
            for p in sorted(root.glob("usr/lib/*-linux-gnu"))
        ]
        library_dirs += ["/lib", "/lib64"]
        package_library_dirs = sorted(
            {
                str(Path(name).parent)
                for name in queue
                if "/node_modules/@openai/" in name
            }
        )
        dynamic = []
        interpreters = set()
        for name in queue:
            source = root / name.lstrip("/")
            headers = run("readelf", "-l", str(source))
            interpreter = re.search(r"Requesting program interpreter: (.*?)\]", headers)
            if interpreter:
                original = interpreter[1]
                actual = copy(original)
                interpreters.add(actual)
                if original != actual:
                    alias(original, actual)
            info = run("readelf", "-d", str(source))
            needed = re.findall(r"\(NEEDED\).*?\[(.*?)\]", info)
            search_dirs = []
            for entry in re.findall(r"\((?:RPATH|RUNPATH)\).*?\[(.*?)\]", info):
                for directory in entry.split(":"):
                    directory = directory.replace(
                        "${ORIGIN}", str(Path(name).parent)
                    ).replace("$ORIGIN", str(Path(name).parent))
                    if not directory.startswith("/") or "$" in directory:
                        raise ValueError(
                            f"Unsupported runtime library search {directory} in {name}"
                        )
                    if (root / directory.lstrip("/")).is_dir():
                        search_dirs.append(resolve(directory))
            if "/node_modules/@openai/" in name:
                search_dirs.extend([str(Path(name).parent), *package_library_dirs])
            search_dirs = list(dict.fromkeys([*search_dirs, *library_dirs]))
            # Static PIE executables have a dynamic table for self-relocation,
            # but no interpreter or shared dependencies to rebind. Altering that
            # table can break the official statically linked Codex executable.
            if "Dynamic section" in info and (interpreter or needed):
                dynamic.append(
                    (name, interpreter[1] if interpreter else None, search_dirs)
                )
            for dependency in needed:
                if "/" in dependency:
                    raise ValueError(
                        f"Unsupported fixed dependency {dependency} in {name}"
                    )
                candidates = [
                    f"{directory}/{dependency}"
                    for directory in search_dirs
                    if (root / directory.lstrip("/") / dependency).exists()
                ]
                if not candidates:
                    raise ValueError(
                        f"Missing immutable dependency {dependency} for {name}"
                    )
                actual = copy(candidates[0])
                if candidates[0] != actual:
                    alias(candidates[0], actual)

        # Rebind every ELF interpreter and dependency search to the immutable
        # mount, including children exec'd by Node/Codex. NODEFLIB prevents a
        # missing dependency from silently falling back to the writable root.
        for name, interpreter, search_dirs in dynamic:
            if name in interpreters:
                continue
            inside = "/" + str((payload / name.lstrip("/")).relative_to(root))
            tool = ["chroot", str(root), "/usr/local/bin/patchelf"]
            # Node's non-PIE ELF requires completing dynamic-table relocation
            # before growing PT_INTERP. A combined edit corrupts its PHDR/LOAD
            # layout, even with patchelf 0.19.2. Real execution below verifies
            # this producer contract instead of accepting a successful patch.
            run(
                *tool,
                "--force-rpath",
                "--set-rpath",
                ":".join(MOUNT + directory for directory in search_dirs),
                inside,
            )
            if interpreter:
                run(*tool, "--set-interpreter", MOUNT + interpreter, inside)
            run(*tool, "--no-default-lib", inside)

        marker = payload / IDENTITY.lstrip("/")
        marker.parent.mkdir(parents=True, exist_ok=True)
        marker.write_text(identity + "\n")
        inventory = []
        for path in sorted(payload.rglob("*")):
            if path.is_file() and not path.is_symlink():
                with path.open("rb") as handle:
                    digest = hashlib.file_digest(handle, "sha256").hexdigest()
                inventory.append(
                    {
                        "path": "/" + str(path.relative_to(payload)),
                        "bytes": path.stat().st_size,
                        "mode": path.stat().st_mode & 0o7777,
                        "sha256": digest,
                    }
                )
            elif path.is_symlink():
                inventory.append(
                    {
                        "path": "/" + str(path.relative_to(payload)),
                        "link": os.readlink(path),
                    }
                )
        (payload / "etc/okou/runtime-files.json").write_text(
            json.dumps({"build": identity, "files": inventory}, separators=(",", ":"))
            + "\n"
        )
        # Content-derived capacity: 25% plus 64 MiB for ext4 metadata/inodes and
        # build margin. No inherited 12 GiB general-tool capacity.
        logical = sum(
            p.stat().st_size
            for p in payload.rglob("*")
            if p.is_file() and not p.is_symlink()
        )
        capacity = (
            (logical * 5 // 4 + 64 * 1024**2 + 1024**2 - 1) // 1024**2
        ) * 1024**2
        with output.open("xb") as image:
            image.truncate(capacity)
        run("mkfs.ext4", "-q", "-F", "-m", "0", "-d", str(payload), str(output))
        run("e2fsck", "-fn", str(output))
        header = run("dumpe2fs", "-h", str(output))
        fields = dict(re.findall(r"^([\w ]+):\s+(\d+)\s*$", header, re.MULTILINE))
        if (
            int(fields["Free blocks"]) * int(fields["Block size"]) < 32 * 1024**2
            or int(fields["Free inodes"]) < 256
        ):
            raise ValueError("Runtime filesystem lacks build headroom")
        target = root / MOUNT.lstrip("/")
        target.mkdir(parents=True, mode=0o755, exist_ok=False)
        run("mount", "-o", "loop,ro,nodev,nosuid", str(output), str(target))
        try:
            # Execute the produced filesystem at its real absolute mount. This
            # smoke check catches broken PT_INTERP/RPATH and JS asset assembly;
            # native execution/tool/restore qualification is a separate gate.
            environment = {
                "PATH": "/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
                "HOME": "/tmp",
                "LANG": "C.UTF-8",
                "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
                "DISABLE_AUTOUPDATER": "1",
                "CODEX_MANAGED_BY_NPM": "1",
                "CODEX_MANAGED_PACKAGE_ROOT": MOUNT + "/usr/local/lib/okou-codex",
            }
            commands = [
                [MOUNT + "/usr/bin/node", "--version"],
                [MOUNT + "/usr/local/bin/claude", "--version"],
                [MOUNT + "/usr/local/bin/codex", "--version"],
            ]
            if cli_version:
                commands.append(
                    [
                        MOUNT + "/usr/bin/node",
                        MOUNT + "/usr/local/lib/okou-agent/agent.js",
                        "--help",
                    ]
                )
            for command in commands:
                result = subprocess.run(
                    # PID namespace teardown kills version/help subprocesses
                    # too, so they cannot retain the image mount after smoke.
                    [
                        "unshare",
                        "--pid",
                        "--fork",
                        "--kill-child=KILL",
                        "chroot",
                        str(root),
                        *command,
                    ],
                    env=environment,
                    text=True,
                    capture_output=True,
                    timeout=30,
                    check=False,
                )
                if result.returncode:
                    raise ValueError(
                        f"Runtime smoke failed ({result.returncode}): {command}; stderr={result.stderr[-4096:]}"
                    )
                print(result.stdout[:4096], end="")
        finally:
            run("umount", str(target))
            target.rmdir()
        print(
            json.dumps(
                {
                    "runtimeLogical": output.stat().st_size,
                    "runtimeAllocated": output.stat().st_blocks * 512,
                    "payloadBytes": logical,
                }
            )
        )

        # Removal happens only after the new filesystem has been built and
        # checked. The caller still verifies both images before publication.
        for path in codex_roots:
            shutil.rmtree(path)
        for path in (
            "/usr/local/bin/claude",
            "/usr/local/bin/codex",
            "/usr/bin/codex",
            "/usr/local/bin/guest-agent",
        ):
            target = root / path.lstrip("/")
            if target.exists() or target.is_symlink():
                target.unlink()
        for name in ("claude", "codex", "guest-agent"):
            target = root / f"usr/local/bin/{name}"
            environment = ""
            if name == "codex":
                environment = (
                    "unset CODEX_MANAGED_BY_BUN CODEX_MANAGED_BY_PNPM CODEX_MANAGED_BY_VITE_PLUS\n"
                    "export CODEX_MANAGED_BY_NPM=1\n"
                    f"export CODEX_MANAGED_PACKAGE_ROOT={MOUNT}/usr/local/lib/okou-codex\n"
                )
            target.write_text(
                f'#!/bin/sh\n{environment}exec {MOUNT}/usr/local/bin/{name} "$@"\n'
            )
            target.chmod(0o755)
        # Preserve npm's public tool entry without retaining another program.
        (root / "usr/bin/codex").symlink_to("../local/bin/codex")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rootfs-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--identity", required=True)
    parser.add_argument("--cli-version", default="")
    args = parser.parse_args()
    if not re.fullmatch(r"[a-f0-9]{64}", args.identity):
        parser.error("Expected runtime input SHA-256")
    split(args.rootfs_dir, args.output, args.identity, args.cli_version)
