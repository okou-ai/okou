#!/usr/bin/env python3
"""Run one real API/native ordering in an owned private mount namespace.

The API controller calls this with its original manifest. The producer JSON is
an operator-frozen input receipt, never a substitute for actual P1 observations.
"""

import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time


def sha(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def main():
    os.umask(0o077)
    if os.geteuid() != 0 or os.readlink("/proc/self/ns/mnt") == os.readlink("/proc/1/ns/mnt"):
        raise ValueError("native API driver requires an owned private mount namespace")
    manifest = Path(sys.argv[1]).resolve(strict=True)
    case = json.loads(manifest.read_text())
    root = manifest.parent
    producer_file = root.parent / "producer.json"
    producer = json.loads(producer_file.read_text())
    source = Path(producer["source_directory"])
    revision = producer["source_sha"]
    if case["source_sha"] != revision or root.name not in ("a", "b", "both"):
        raise ValueError("actual API manifest has another source or order")
    if sha(producer["source_manifest"]) != producer["source_manifest_sha256"]:
        raise ValueError("frozen source manifest changed")
    for item in producer["binaries"].values():
        if sha(item["path"]) != item["sha256"]:
            raise ValueError("a frozen native input changed")
    snapshot = Path(producer["snapshot_directory"])
    artifacts = producer["artifacts"]
    for name, digest in artifacts["snapshot_files"].items():
        if sha(snapshot / name) != digest:
            raise ValueError("matching snapshot input changed")
    if sha(snapshot / "snapshot-preparation.json") != artifacts["snapshot_preparation_sha256"]:
        raise ValueError("matching snapshot producer changed")
    for item in json.loads(Path(producer["source_manifest"]).read_text())["files"]:
        path = source / item["path"]
        raw = os.readlink(path).encode() if item["mode"] == "120000" else path.read_bytes()
        if hashlib.sha256(raw).hexdigest() != item["sha256"]:
            raise ValueError("API/Host source bytes changed after freeze")
    policy_file = Path(producer["policy_file"])
    raw_policy = policy_file.read_text()
    if sha(policy_file) != artifacts["policy_sha256"]:
        raise ValueError("supplied uncalibrated policy changed")
    if shutil.disk_usage(root).free < 80 * 1024**3:
        raise ValueError("insufficient space for two independent owners")
    invocation = Path("/var/tmp/okou-issue-41467-" + revision[:12] + "-" + root.name)
    invocation.mkdir(mode=0o700)
    work = invocation / "work"
    work.mkdir(mode=0o700)
    metadata = {"native_terminal_artifacts": artifacts,
        "native_real_api_policy_json": raw_policy,
        "native_real_api_producer_sha256": sha(producer_file),
        "supplied_policy_is_calibrated": False}
    metadata_file = root / "metadata.json"
    metadata_file.write_text(json.dumps(metadata, indent=2))
    artifacts_file = root / "artifacts.json"
    artifacts_file.write_text(json.dumps({k: v for k, v in artifacts.items()
        if k not in ("profile", "required_fixture_tail_bytes")}, indent=2))
    binaries = producer["binaries"]
    env = {"PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "PYTHONDONTWRITEBYTECODE": "1", "OKOU_TEST_REAL_API_MANIFEST": str(manifest),
        "OKOU_TEST_RPC_FIRECRACKER": binaries["firecracker"]["path"],
        "OKOU_TEST_RPC_KERNEL": binaries["kernel"]["path"],
        "OKOU_TEST_RPC_ROOTFS": binaries["rootfs"]["path"],
        "OKOU_TEST_RPC_SNAPSHOT_DIR": str(snapshot), "OKOU_TEST_RPC_SNAPSHOT_HASH": artifacts["snapshot_id"],
        "OKOU_TEST_RPC_BASE_DIR": str(work), "OKOU_TEST_IDLE_ROOTFS_HASH": artifacts["rootfs_sha256"],
        "OKOU_TEST_IDLE_MEMORY_POLICY": str(policy_file), "OKOU_TEST_TERMINAL_ARTIFACTS": str(artifacts_file)}
    command = ["python3", "-B", str(source/".github/scripts/runner-memory-calibrate.py"),
        "--output", str(invocation/"p1"), "--metadata", str(metadata_file), "--duration-seconds", "550",
        "--interval-seconds", ".05", "--cleanup-grace-seconds", "30", "--minimum-available-mib", "8192",
        "--max-log-bytes", "16777216", "--", "/usr/bin/env", "-i",
        *(k+"="+v for k, v in sorted(env.items())), binaries["host"]["path"],
        "native_real_api_competing_claims_preserve_both_owners", "--ignored", "--exact", "--nocapture", "--test-threads=1"]
    receipt = {"source_sha": revision, "command": command, "driver_sha256": sha(__file__),
        "started_monotonic_ns": time.monotonic_ns(), "started_unix_ns": time.time_ns()}
    with (root/"collector.log").open("x") as log:
        process = subprocess.run(command, stdout=log, stderr=subprocess.STDOUT)
    receipt.update(exit_code=process.returncode, completed_monotonic_ns=time.monotonic_ns(), completed_unix_ns=time.time_ns())
    (root/"process.json").write_text(json.dumps(receipt, indent=2))
    if (invocation/"p1").exists():
        shutil.copyfile(snapshot/"snapshot-preparation.json", invocation/"p1/snapshot-preparation.json")
        shutil.move(invocation/"p1", root/"p1")
    if process.returncode:
        raise RuntimeError("native arbitration failed; original evidence and uncertain owners retained")
    if list(work.iterdir()):
        raise RuntimeError("native success retained runtime directories")
    work.rmdir()
    invocation.rmdir()


if __name__ == "__main__":
    main()
