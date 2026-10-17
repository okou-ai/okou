import argparse
import json
import os
import platform
import re
import selectors
import shutil
import signal
import stat
import subprocess
import sys
import time
from pathlib import Path

from packaged_policy import build_policy
from run import (
    METADATA,
    artifact_identity,
    copy_artifact,
    initramfs,
    sha256,
    unique_fields,
)

HERE = Path(__file__).resolve().parent
EXPECTED = {
    "user_bridge_metadata_denied",
    "root_bridge_metadata_denied",
    "user_task_stop_workload",
    "root_task_stop_workload",
    "control_runtime_on_sealed_drive",
    "workload_direct_ingress",
    "root_direct_ingress",
    "root_raw_device_open_denied",
    "root_protected_file_ioctl_denied",
    "ordinary_network",
    "sudo_offline_package_install",
    "installed_tool_root_stays_workload",
    "agent_dependency_view_separate",
    "workload_terminal",
    "node_packaged_version",
    "claude_packaged_version",
    "codex_packaged_version",
    "packaged_image_worker_round_trip",
    "pi_real_image_read",
    "pi_real_tool_subagent",
    "untrusted_pi_extension_denied",
    "pi_sdk_extension_loader_diagnostic",
    "pi_extension_known_load_control",
    "pi_frozen_resource_mutation_denied",
    "pi_resource_anchors_stable",
    "pi_retained_sessions",
    "pi_private_state_denied",
    "claude_mcp_direct",
    "claude_mcp_lowered",
    "codex_mcp_direct",
    "codex_mcp_lowered",
    "storage_file_archive",
    "storage_http_archive",
    "real_pi_child_cancellation",
    "user_cgroup_migration_denied",
    "root_cgroup_migration_denied",
    "production_resource_policy_applied",
    "real_tool_resource_accounting",
    "real_tool_group_oom_contained",
    "workload_browser_dom",
    "real_pi_continues_after_tool_oom",
    "user_namespace_stays_workload",
    "pi_reopens_real_history",
    "claude_reopens_real_history",
    "codex_reopens_real_history",
    "claude_real_tool_subagent",
    "codex_real_tool_subagent",
    "untrusted_shell_startup_denied",
    "enforcing_after_runtimes",
}
VERSIONS = {
    "cli": "9.400.3",
    "piAgentRuntime": "1.50.18",
    "piSdk": "1.1.0+okou.592c3e597de7",
}
PACKAGE = {
    "sha256": "8cfbcfd898a0c578b2d17f566c2c90b2cca1a3d21727a4ad85a6bd6528d457d3",
    "size": 15865254,
}


def validate_summary(summary, architecture, boot_mode="fresh"):
    if not isinstance(summary, dict) or summary.get("gateF") != "incomplete":
        raise ValueError("invalid packaged scope/gate")
    if "fixtureError" in summary:
        raise ValueError("Guest fixture failed: " + str(summary["fixtureError"]))
    if summary.get("bootMode") != boot_mode:
        raise ValueError("wrong observed native boot mode")
    if boot_mode == "restored":
        observed = summary.get("restoration")
        if (
            not isinstance(observed, dict)
            or not isinstance(observed.get("before"), dict)
            or observed.get("before") != observed.get("after")
            or observed["before"].get("enforcing") != "1"
            or observed["before"].get("controllerContext")
            != "system_u:system_r:control_t"
            or any(
                not isinstance(observed["before"].get(name), str)
                or re.fullmatch(r"mnt:\[\d+\]", observed["before"][name]) is None
                for name in ("agentNamespace", "workloadNamespace")
            )
            or observed["before"]["agentNamespace"]
            == observed["before"]["workloadNamespace"]
        ):
            raise ValueError("restore lacks unchanged enforcing checkpoint")
    kernel = summary.get("kernel")
    if (
        not isinstance(kernel, dict)
        or kernel.get("architecture") != architecture
        or kernel.get("enforcing") is not True
        or not isinstance(kernel.get("lsm"), str)
        or "selinux" not in kernel["lsm"].split(",")
    ):
        raise ValueError("missing actual enforcing Guest kernel")
    manifest = summary.get("installedManifest")
    if (
        not isinstance(manifest, dict)
        or manifest.get("schemaVersion") != 1
        or manifest.get("versions") != VERSIONS
        or manifest.get("package") != PACKAGE
        or manifest.get("entrypoint") != "/usr/local/lib/okou-cli/9.400.3/okou.js"
    ):
        raise ValueError("wrong packaged CLI identity")
    checks = summary.get("results")
    if not isinstance(checks, list) or any(not isinstance(c, dict) for c in checks):
        raise ValueError("invalid packaged checks")
    names = [c.get("name") for c in checks]
    if (
        any(not isinstance(n, str) for n in names)
        or len(names) != len(set(names))
        or set(names) != EXPECTED
    ):
        raise ValueError("missing, duplicate or unknown packaged checks")
    if (
        any(c.get("passed") is not True for c in checks)
        or summary.get("brokerErrors") != []
    ):
        raise ValueError("failed or unqualified packaged case")
    by_name = {c["name"]: c for c in checks}
    control = by_name["pi_extension_known_load_control"]
    identity = control.get("identity")
    denied = by_name["untrusted_pi_extension_denied"]
    if (
        control.get("qualified") is not True
        or not isinstance(identity, dict)
        or identity.get("uid") != 1000
        or not isinstance(identity.get("context"), str)
        or identity["context"].rstrip("\0") != "system_u:system_r:agent_t"
        or control.get("ingressObserved") is not True
        or denied.get("qualified") is not True
        or denied.get("executed") is not None
        or denied.get("ingressObserved") is not False
    ):
        raise ValueError("Pi extension denial lacks a known-load control")
    for framework in ("claude", "codex"):
        for mode in ("direct", "lowered"):
            case = by_name[framework + "_mcp_" + mode]
            observed = case.get("identity")
            direct = mode == "direct"
            if (
                not isinstance(observed, dict)
                or observed.get("uid") != 1000
                or observed.get("initialized") is not True
                or observed.get("capEff") != "0000000000000000"
                or type(observed.get("connectErrno")) is not int
                or observed.get("context")
                != "system_u:system_r:" + ("agent_t" if direct else "workload_t")
                or observed.get("connectErrno") not in ((0,) if direct else (1, 13))
                or case.get("ingressObserved") is not direct
            ):
                raise ValueError(
                    "MCP handoff lacks actual protocol/role/ingress evidence"
                )
    shell = by_name["untrusted_shell_startup_denied"]
    observations = shell.get("observations")
    if not isinstance(observations, list) or any(
        not isinstance(o, dict) for o in observations
    ):
        raise ValueError("missing actual shell startup observations")
    if (
        not {"claude", "codex"}.issubset({o.get("framework") for o in observations})
        or shell.get("ingressObserved") is not False
        or any(
            o.get("context") != "system_u:system_r:workload_t"
            or type(o.get("connectErrno")) is not int
            or o["connectErrno"] not in (1, 13)
            for o in observations
        )
    ):
        raise ValueError("untrusted shell startup retained authority")


def decode_summary(raw):
    if len(raw.encode()) > 131072:
        raise ValueError("native result bound")
    return json.loads(raw, object_pairs_hook=unique_fields)


def snapshot_receipt(out, *, complete):
    value = decode_summary((out / "snapshot-receipt.json").read_text())
    if not isinstance(value, dict):
        raise TypeError("invalid snapshot receipt")
    processes = value.get("processes")
    if (
        value.get("schemaVersion") != 1
        or value.get("result") not in ("failed", "restored_and_joined")
        or not isinstance(processes, list)
        or len(processes) > 2
    ):
        raise ValueError("invalid snapshot ownership receipt")
    pids = set()
    for process in processes:
        if process == {"cleanup": "not_started"}:
            continue
        if (
            not isinstance(process, dict)
            or type(process.get("pid")) is not int
            or process["pid"] <= 1
            or process["pid"] in pids
            or process.get("cleanup") != "joined"
            or type(process.get("exit")) is not int
            or Path(f"/proc/{process['pid']}").exists()
        ):
            raise ValueError("snapshot child cleanup is unverified")
        pids.add(process["pid"])
    if complete and (
        value["result"] != "restored_and_joined"
        or len(pids) != 2
        or processes[1].get("exit") != 0
        or value.get("snapshot")
        != {
            name: {"bytes": path.stat().st_size, "sha256": sha256(path)}
            for name in ("state", "memory")
            for path in (out / ("snapshot." + name),)
        }
    ):
        raise ValueError("snapshot was not restored with matching owned inputs")
    return value


def vm(command, log_path, receipt, timeout=240, max_bytes=131072):
    signals = (signal.SIGINT, signal.SIGTERM, signal.SIGHUP)

    def interrupted(number, _frame):
        raise InterruptedError(number)

    mask = signal.pthread_sigmask(signal.SIG_BLOCK, signals)
    handlers = {s: signal.signal(s, interrupted) for s in signals}
    child = None
    try:
        with log_path.open("xb") as log:
            child = subprocess.Popen(
                [
                    sys.executable,
                    str(HERE / "packaged_fence.py"),
                    str(os.getpid()),
                    json.dumps(sorted(mask)),
                    *command,
                ],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )
            receipt["vmmPid"] = child.pid
            receipt["cleanup"] = "running"
            signal.pthread_sigmask(signal.SIG_SETMASK, mask)
            deadline = time.monotonic() + timeout
            selector = selectors.DefaultSelector()
            selector.register(child.stdout, selectors.EVENT_READ)
            size = 0
            try:
                while True:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise TimeoutError("packaged VM deadline")
                    ready = selector.select(remaining)
                    if not ready:
                        raise TimeoutError("packaged VM deadline")
                    chunk = os.read(child.stdout.fileno(), 16384)
                    if not chunk:
                        break
                    size += len(chunk)
                    if size > max_bytes:
                        raise ValueError("packaged console bound")
                    log.write(chunk)
                    log.flush()
                child.wait(timeout=5)
                if child.returncode:
                    raise ValueError(f"VMM exit {child.returncode}")
            finally:
                selector.close()
    finally:
        signal.pthread_sigmask(signal.SIG_BLOCK, signals)
        try:
            if child is not None:
                if child.poll() is None:
                    try:
                        os.killpg(child.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        # It already exited; wait below still joins the owned child.
                        pass
                child.wait(timeout=5)
                child.stdout.close()
                receipt["cleanup"] = "vmm_joined"
        finally:
            for s, h in handlers.items():
                signal.signal(s, h)
            signal.pthread_sigmask(signal.SIG_SETMASK, mask)


def main():
    parser = argparse.ArgumentParser()
    for name in (
        "kernel",
        "firecracker",
        "secilc",
        "base-rootfs",
        "tool-helper",
        "task-helper",
        "storage-helper",
        "resource-helper",
        "output",
    ):
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--rootfs-sha256", required=True)
    parser.add_argument("--source-revision", required=True)
    parser.add_argument("--snapshot-restore", action="store_true")
    args = parser.parse_args()
    if re.fullmatch(r"[a-f0-9]{40}", args.source_revision) is None:
        parser.error("source revision must be a full lowercase commit SHA")
    if re.fullmatch(r"[a-f0-9]{64}", args.rootfs_sha256) is None:
        parser.error("rootfs digest must be a full lowercase SHA-256")
    out = args.output.resolve()
    out.mkdir(mode=0o700)
    architecture = platform.machine()
    receipt = {
        "scope": "experimental-packaged-runtime-prototype",
        "sourceRevision": args.source_revision,
        "architecture": architecture,
        "gateF": "incomplete",
        "bootMode": "restored" if args.snapshot_restore else "fresh",
        "result": "failed",
        "cleanup": "not_started",
        "limits": {
            "memoryMiB": 1536,
            "vcpus": 2,
            "deadlineSeconds": 240,
            "consoleBytes": 131072,
        },
    }
    try:
        for path in (
            args.kernel,
            args.firecracker,
            args.base_rootfs,
            args.tool_helper,
            args.task_helper,
            args.storage_helper,
            args.resource_helper,
            args.secilc,
        ):
            if not stat.S_ISREG(path.stat().st_mode):
                raise ValueError(f"native input is not a regular file: {path}")
        image_stat = args.base_rootfs.stat()
        if image_stat.st_mode & 0o222 or not 0 < image_stat.st_size <= 32 * 1024**3:
            raise ValueError("base rootfs must be read-only and at most 32 GiB")
        metadata = METADATA.read_text()
        receipt["kernel"] = copy_artifact(
            args.kernel,
            out / "kernel",
            artifact_identity(metadata, "KERNEL", architecture),
        )
        receipt["vmm"] = copy_artifact(
            args.firecracker,
            out / "firecracker",
            artifact_identity(metadata, "FIRECRACKER", architecture),
            True,
        )
        if sha256(args.base_rootfs) != args.rootfs_sha256:
            raise ValueError("base rootfs mismatch")
        receipt["rootfs"] = {
            "sha256": args.rootfs_sha256,
            "bytes": args.base_rootfs.stat().st_size,
        }
        receipt["fixtureInputs"] = {
            p.name: sha256(p)
            for p in [*HERE.glob("packaged_*"), HERE / "run.py", HERE / "policy.py"]
            if p.is_file()
        }
        receipt["dependencyMetadataSha256"] = sha256(METADATA)
        receipt["helpers"] = {
            "tool": sha256(args.tool_helper),
            "task": sha256(args.task_helper),
            "storage": sha256(args.storage_helper),
            "resourcePolicy": sha256(args.resource_helper),
        }
        compiler = Path(shutil.which("gcc")).resolve()
        policy_compiler = args.secilc.resolve()
        receipt["compilers"] = {
            "cc": sha256(compiler),
            "secilc": sha256(policy_compiler),
        }
        subprocess.run(
            [
                "cp",
                "--reflink=auto",
                "--sparse=always",
                str(args.base_rootfs),
                str(out / "rootfs.ext4"),
            ],
            check=True,
            timeout=120,
        )
        (out / "rootfs.ext4").chmod(0o600)
        if sha256(out / "rootfs.ext4") != args.rootfs_sha256:
            raise ValueError("copied rootfs mismatch")
        (out / "policy.cil").write_text(build_policy())
        subprocess.run(
            [
                str(policy_compiler),
                "-M",
                "false",
                "-c",
                "33",
                "-o",
                str(out / "policy"),
                "-f",
                str(out / "file_contexts"),
                str(out / "policy.cil"),
            ],
            check=True,
            timeout=30,
        )
        for source, target in [
            ("packaged_init.c", "init"),
            ("packaged_entry.c", "entry"),
        ]:
            subprocess.run(
                [
                    str(compiler),
                    "-std=c11",
                    "-Wall",
                    "-Wextra",
                    "-Werror",
                    "-O2",
                    "-static",
                    "-o",
                    str(out / target),
                    str(HERE / source),
                ],
                check=True,
                timeout=30,
            )
        entries = [
            (name, stat.S_IFDIR | 0o755, b"", 0, 0)
            for name in ("dev", "fixture", "rootfs")
        ]
        entries += [
            ("dev/console", stat.S_IFCHR | 0o600, b"", 5, 1),
            ("init", stat.S_IFREG | 0o500, (out / "init").read_bytes(), 0, 0),
        ]
        for name, path in [
            ("guest.py", HERE / "packaged_guest.py"),
            ("packaged_resources.py", HERE / "packaged_resources.py"),
            ("packaged_accounting.py", HERE / "packaged_accounting.py"),
            ("packaged_audit.py", HERE / "packaged_audit.py"),
            ("packaged_browser.py", HERE / "packaged_browser.py"),
            ("packaged_history.py", HERE / "packaged_history.py"),
            ("packaged_mcp.py", HERE / "packaged_mcp.py"),
            ("packaged_mcp_peer.py", HERE / "packaged_mcp_peer.py"),
            ("packaged_storage.py", HERE / "packaged_storage.py"),
            ("packaged_lifecycle.py", HERE / "packaged_lifecycle.py"),
            ("guest-storage-apply", args.storage_helper),
            ("resource-policy", args.resource_helper),
            ("policy", out / "policy"),
            ("entry", out / "entry"),
            ("real-guest-tool-exec", args.tool_helper),
            ("real-guest-task-exec", args.task_helper),
        ]:
            entries.append(
                ("fixture/" + name, stat.S_IFREG | 0o500, path.read_bytes(), 0, 0)
            )
        entries.append(("TRAILER!!!", 0, b"", 0, 0))
        (out / "initramfs.gz").write_bytes(initramfs(entries))
        config = {
            "boot-source": {
                "kernel_image_path": str(out / "kernel"),
                "initrd_path": str(out / "initramfs.gz"),
                "boot_args": "console=ttyS0 reboot=k panic=1 pci=off nomodules random.trust_cpu=on quiet loglevel=6 nokaslr audit=1 audit_backlog_limit=4096 rdinit=/init",
            },
            "machine-config": {"vcpu_count": 2, "mem_size_mib": 1536},
            "drives": [
                {
                    "drive_id": "rootfs",
                    "path_on_host": str(out / "rootfs.ext4"),
                    "is_root_device": False,
                    "is_read_only": False,
                },
                {
                    "drive_id": "sealed",
                    "path_on_host": str(args.base_rootfs.resolve()),
                    "is_root_device": False,
                    "is_read_only": True,
                },
            ],
            "network-interfaces": [],
        }
        if args.snapshot_restore:
            config["boot-source"]["boot_args"] += " caller_restore=1"
        (out / "vm.json").write_text(json.dumps(config))
        receipt["generatedInputs"] = {
            name: sha256(out / name)
            for name in (
                "init",
                "entry",
                "policy.cil",
                "policy",
                "initramfs.gz",
                "vm.json",
            )
        }
        command = (
            [sys.executable, str(HERE / "packaged_snapshot.py"), str(out)]
            if args.snapshot_restore
            else [
                str(out / "firecracker"),
                "--no-api",
                "--config-file",
                str(out / "vm.json"),
            ]
        )
        vm(
            command,
            out / "console.log",
            receipt,
        )
        if args.snapshot_restore:
            receipt["cleanup"] = "snapshot_children_unverified"
            receipt["snapshot"] = snapshot_receipt(out, complete=True)
            receipt["cleanup"] = "vmm_joined"
        result = subprocess.run(
            ["debugfs", "-R", "cat /native-result.json", str(out / "rootfs.ext4")],
            capture_output=True,
            text=True,
            check=True,
            timeout=15,
        )
        (out / "guest-result.json").write_text(result.stdout)
        summary = decode_summary(result.stdout)
        receipt["guest"] = summary
        validate_summary(summary, architecture, receipt["bootMode"])
        receipt["result"] = "passed_subset"
    except BaseException as error:
        receipt["error"] = str(error)
        raise
    finally:
        if args.snapshot_restore:
            receipt["snapshotSupervisorPid"] = receipt.pop("vmmPid", None)
            if (
                receipt["cleanup"] in ("vmm_joined", "snapshot_children_unverified")
                and "snapshot" not in receipt
            ):
                try:
                    receipt["snapshot"] = snapshot_receipt(out, complete=False)
                    receipt["cleanup"] = "vmm_joined"
                except (OSError, ValueError, TypeError):
                    receipt["cleanup"] = "snapshot_children_unverified"
        (out / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
        # The only mutable drive belongs to this attempt. Retain input identity
        # and synthetic console/receipt; release its multi-GB disposable copy.
        if receipt["cleanup"] in ("not_started", "vmm_joined"):
            (out / "rootfs.ext4").unlink(missing_ok=True)


if __name__ == "__main__":
    main()
