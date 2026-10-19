"""Boot an owned, credential-free Guest to test SELinux role primitives.

This is not the complete packaged-agent qualification gate. The receipt keeps
that distinction even when every primitive succeeds.
"""

import argparse
import errno
import gzip
import hashlib
import json
import os
import platform
import re
import shutil
import signal
import stat
import subprocess
import sys
import time
from pathlib import Path

from policy import build_policy

HERE = Path(__file__).resolve().parent
METADATA = HERE.parents[1] / "src/deps.rs"
PREFIXES = (
    "OKOU_CALLER_KERNEL ",
    "OKOU_CALLER_CASE ",
    "OKOU_CALLER_DONE ",
    "OKOU_CALLER_FATAL ",
)
EXPECTED = {
    "agent_model_connect": (0, "agent_t", True),
    "gateway_key_read": (0, "gateway_t", True),
    "agent_key_read_denied": (0, "agent_t", False),
    "agent_code_write_denied": (0, "agent_t", False),
    "user_model_connect_denied": (1000, "workload_t", False),
    "root_model_connect_denied": (0, "workload_t", False),
    "root_model_bind_denied": (0, "workload_t", False),
    "user_data_write": (1000, "workload_t", True),
    "root_data_write": (0, "workload_t", True),
    "user_ordinary_network": (1000, "workload_t", True),
    "root_ordinary_network": (0, "workload_t", True),
    "root_code_write_denied": (0, "workload_t", False),
    "user_code_write_denied": (1000, "workload_t", False),
    "root_key_read_denied": (0, "workload_t", False),
    "root_disable_policy_denied": (0, "workload_t", False),
    "root_relabel_denied": (0, "workload_t", False),
    "root_raw_socket_denied": (0, "workload_t", False),
    "root_mount_denied": (0, "workload_t", False),
    "root_process_memory_denied": (0, "workload_t", False),
    "root_forge_role_denied": (0, "workload_t", False),
    "root_inherited_socket_denied": (0, "workload_t", False),
    "root_steal_key_fd_denied": (0, "workload_t", False),
    "root_inherited_key_denied": (0, "workload_t", False),
    "root_network_control_denied": (0, "workload_t", False),
}
REMAINING = [
    "real packaged Codex/Claude Code/Pi and supported tool/subagent paths",
    "sealed runtime/dependency closure and ordinary sudo/package compatibility",
    "retained home/history/cache and full lifecycle/resource accounting",
    "actual eligible provider/Runner matrix and alternate credential resolvers",
]


def unique_fields(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate native receipt field: {key}")
        result[key] = value
    return result


def sha256(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def artifact_identity(source, name, architecture):
    suffix = {"x86_64": "X86_64", "aarch64": "AARCH64"}[architecture]
    size = re.search(rf"pub const {name}_SIZE_{suffix}: u64 = ([0-9_]+);", source)
    digest = re.search(
        rf'pub const {name}_SHA256_{suffix}: &str =\s*"([a-f0-9]{{64}})";', source
    )
    if not size or not digest:
        raise ValueError(f"missing exact {name}/{architecture} dependency identity")
    return int(size.group(1).replace("_", "")), digest.group(1)


def copy_artifact(source, destination, identity, executable=False):
    with source.open("rb") as incoming, destination.open("xb") as outgoing:
        shutil.copyfileobj(incoming, outgoing)
    actual = (destination.stat().st_size, sha256(destination))
    if actual != identity:
        raise ValueError(f"artifact identity mismatch: {source}")
    destination.chmod(0o500 if executable else 0o400)
    return {"bytes": actual[0], "sha256": actual[1]}


def initramfs(entries):
    """Create deterministic newc bytes without host mounts or device creation."""
    archive = bytearray()
    for inode, (name, mode, data, major, minor) in enumerate(entries, 1):
        encoded = name.encode() + b"\0"
        fields = (
            inode,
            mode,
            0,
            0,
            1,
            0,
            len(data),
            0,
            0,
            major,
            minor,
            len(encoded),
            0,
        )
        archive.extend(b"070701" + "".join(f"{value:08x}" for value in fields).encode())
        archive.extend(encoded)
        archive.extend(b"\0" * (-len(archive) % 4))
        archive.extend(data)
        archive.extend(b"\0" * (-len(archive) % 4))
    archive.extend(b"\0" * (-len(archive) % 512))
    return gzip.compress(archive, mtime=0)


def parse_receipt(log, architecture):
    kernels, checks, summaries = [], [], []
    for line in log.splitlines():
        for prefix in PREFIXES:
            if line.startswith(prefix):
                value = json.loads(line[len(prefix) :], object_pairs_hook=unique_fields)
                if not isinstance(value, dict):
                    raise ValueError("native receipt record must be an object")
                if prefix == PREFIXES[0]:
                    kernels.append(value)
                elif prefix == PREFIXES[1]:
                    checks.append(value)
                elif prefix == PREFIXES[2]:
                    summaries.append(value)
                else:
                    raise ValueError(f"Guest setup/probe failed: {value}")
    if len(kernels) != 1 or kernels[0].get("machine") != architecture:
        raise ValueError(
            "missing, duplicate or wrong-architecture Guest kernel observation"
        )
    if not isinstance(kernels[0].get("lsm"), str) or "selinux" not in kernels[0][
        "lsm"
    ].split(","):
        raise ValueError("Guest did not establish an active SELinux LSM")
    if len(summaries) != 1:
        raise ValueError("missing or duplicate completed Guest summary")
    names = [check.get("name") for check in checks]
    if len(names) != len(set(names)) or set(names) != set(EXPECTED):
        raise ValueError("missing, duplicate or unknown primitive checks")
    for check in checks:
        uid, domain, allowed = EXPECTED[check["name"]]
        if type(check.get("uid")) is not int or check["uid"] != uid:
            raise ValueError(f"wrong workload uid: {check['name']}")
        caps = check.get("capEff")
        if not isinstance(caps, str) or re.fullmatch("[a-f0-9]{16}", caps) is None:
            raise ValueError("missing actual effective capabilities")
        root_caps = (1 << 21) | (1 << 12) | (1 << 13) | (1 << 19)
        if (uid == 0 and int(caps, 16) & root_caps != root_caps) or (
            uid != 0 and int(caps, 16) != 0
        ):
            raise ValueError(f"wrong effective capabilities: {check['name']}")
        if check.get("context") != f"system_u:system_r:{domain}":
            raise ValueError(f"wrong actual role: {check['name']}")
        if check.get("allowed") is not allowed or check.get("passed") is not True:
            raise ValueError(f"failed primitive: {check['name']}")
        result, error = check.get("result"), check.get("errno")
        if type(result) is not int or type(error) is not int:
            raise ValueError("invalid native result/errno")
        if (allowed and (result != 0 or error != 0)) or (
            not allowed and (result != -1 or error not in (errno.EACCES, errno.EPERM))
        ):
            raise ValueError(
                f"operation did not establish expected access/denial: {check['name']}"
            )
    summary = summaries[0]
    if (
        type(summary.get("cases")) is not int
        or summary["cases"] != len(EXPECTED)
        or type(summary.get("failures")) is not int
        or summary["failures"] != 0
        or summary.get("enforcing") is not True
    ):
        raise ValueError("incomplete or non-enforcing primitive result")
    return {"kernel": kernels[0], "checks": checks, "summary": summary}


def run_vm(command, log_path, receipt, timeout=35):
    def interrupted(number, _frame):
        raise InterruptedError(f"native owner received signal {number}")

    interrupts = (signal.SIGINT, signal.SIGTERM, signal.SIGHUP)
    original_mask = signal.pthread_sigmask(signal.SIG_BLOCK, interrupts)
    previous = {number: signal.signal(number, interrupted) for number in interrupts}
    process = None
    try:
        with log_path.open("xb") as log:
            process = subprocess.Popen(
                [
                    sys.executable,
                    str(HERE / "vmm.py"),
                    str(os.getpid()),
                    json.dumps(sorted(original_mask)),
                    *command,
                ],
                stdin=subprocess.DEVNULL,
                stdout=log,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )
            receipt["vmmPid"] = process.pid
            receipt["cleanup"] = "vmm_running"
            # Pending cancellation can run only after Popen is owned. The exec
            # wrapper restores the child's original mask independently.
            signal.pthread_sigmask(signal.SIG_SETMASK, original_mask)
            try:
                process.wait(timeout=timeout)
            except subprocess.TimeoutExpired as error:
                raise TimeoutError(
                    "owned Firecracker exceeded native deadline"
                ) from error
            if process.returncode:
                raise ValueError(
                    f"owned Firecracker failed with exit {process.returncode}"
                )
    finally:
        signal.pthread_sigmask(signal.SIG_BLOCK, interrupts)
        try:
            if process is not None:
                if process.poll() is None:
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass  # Owned VMM exited between poll and signal.
                process.wait(timeout=5)
                receipt["cleanup"] = "vmm_joined"
        finally:
            for number, handler in previous.items():
                signal.signal(number, handler)
            signal.pthread_sigmask(signal.SIG_SETMASK, original_mask)


def run(args):
    architecture = platform.machine()
    if platform.system() != "Linux" or architecture not in ("x86_64", "aarch64"):
        raise ValueError("only real supported native host architectures are accepted")
    if not re.fullmatch("[a-f0-9]{40}", args.source_revision):
        raise ValueError("source revision must be an exact 40-hex commit")
    directory = args.output.resolve()
    directory.mkdir(mode=0o700, parents=False, exist_ok=False)
    receipt = {
        "schemaVersion": 1,
        "scope": "kernel-role-primitives",
        "sourceRevision": args.source_revision,
        "architecture": architecture,
        "gateF": "incomplete",
        "remaining": REMAINING,
        "primitiveResult": "failed",
        "limits": {
            "vcpuCount": 1,
            "guestMemoryMiB": 128,
            "deadlineSeconds": 35,
            "consoleBytes": 131072,
        },
        "cleanup": "not_started",
    }
    start = time.monotonic()
    try:
        metadata = METADATA.read_text()
        receipt["dependencyMetadataSha256"] = sha256(METADATA)
        receipt["fixtureInputs"] = {
            name: sha256(HERE / name)
            for name in ("run.py", "policy.py", "probe.c", "vmm.py")
        }
        receipt["kernelArtifact"] = copy_artifact(
            args.kernel,
            directory / "kernel",
            artifact_identity(metadata, "KERNEL", architecture),
        )
        receipt["vmmArtifact"] = copy_artifact(
            args.firecracker,
            directory / "firecracker",
            artifact_identity(metadata, "FIRECRACKER", architecture),
            executable=True,
        )
        receipt["policyCompiler"] = {
            "path": str(args.secilc.resolve()),
            "sha256": sha256(args.secilc),
        }
        cc = shutil.which(args.cc)
        if cc is None:
            raise ValueError("native C compiler is unavailable")
        cc_path = Path(cc).resolve()
        receipt["cCompiler"] = {
            "path": str(cc_path),
            "sha256": sha256(cc_path),
        }
        (directory / "policy.cil").write_text(build_policy())
        subprocess.run(
            [
                str(args.secilc.resolve()),
                "-M",
                "false",
                "-c",
                "33",
                "-o",
                str(directory / "policy"),
                "-f",
                str(directory / "file_contexts"),
                str(directory / "policy.cil"),
            ],
            check=True,
            timeout=30,
            stdout=sys.stderr,
        )
        subprocess.run(
            [
                str(cc_path),
                "-std=c11",
                "-Wall",
                "-Wextra",
                "-Werror",
                "-O2",
                "-static",
                "-o",
                str(directory / "init"),
                str(HERE / "probe.c"),
            ],
            check=True,
            timeout=60,
            stdout=sys.stderr,
        )
        entries = [
            (name, stat.S_IFDIR | 0o755, b"", 0, 0)
            for name in ("dev", "proc", "sys", "fixture")
        ]
        entries += [
            ("dev/console", stat.S_IFCHR | 0o600, b"", 5, 1),
            ("init", stat.S_IFREG | 0o500, (directory / "init").read_bytes(), 0, 0),
            ("policy", stat.S_IFREG | 0o400, (directory / "policy").read_bytes(), 0, 0),
            ("TRAILER!!!", 0, b"", 0, 0),
        ]
        (directory / "initramfs.cpio.gz").write_bytes(initramfs(entries))
        config = {
            "boot-source": {
                "kernel_image_path": str(directory / "kernel"),
                "initrd_path": str(directory / "initramfs.cpio.gz"),
                "boot_args": "console=ttyS0 reboot=k panic=1 pci=off nomodules random.trust_cpu=on quiet loglevel=6 nokaslr audit=1 rdinit=/init",
            },
            "machine-config": {"vcpu_count": 1, "mem_size_mib": 128},
            "drives": [],
            "network-interfaces": [],
        }
        (directory / "vm.json").write_text(json.dumps(config))
        receipt["generatedInputs"] = {
            name: sha256(directory / name)
            for name in ("init", "policy.cil", "policy", "initramfs.cpio.gz", "vm.json")
        }
        receipt["cleanup"] = "no_live_vm"
        run_vm(
            [
                str(directory / "firecracker"),
                "--no-api",
                "--config-file",
                str(directory / "vm.json"),
            ],
            directory / "console.log",
            receipt,
        )
        receipt["native"] = parse_receipt(
            (directory / "console.log").read_text(), architecture
        )
        receipt["primitiveResult"] = "passed"
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        receipt["error"] = str(error)
        raise
    finally:
        receipt["elapsedSeconds"] = time.monotonic() - start
        (directory / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
        print(json.dumps(receipt), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--kernel", type=Path, required=True)
    parser.add_argument("--firecracker", type=Path, required=True)
    parser.add_argument("--secilc", type=Path, required=True)
    parser.add_argument(
        "--output",
        type=Path,
        required=True,
        help="new exclusive directory beneath an existing owned parent",
    )
    parser.add_argument("--source-revision", required=True)
    parser.add_argument("--cc", default="gcc")
    run(parser.parse_args())
