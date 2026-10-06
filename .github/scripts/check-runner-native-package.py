#!/usr/bin/env python3
"""Inspect REAL Runner exports; optionally exercise their real native protocol.

Run on a matching native CPU. No downloads, builds, backend/env overrides,
credentials, KDCs, host-policy changes, or privilege escalation are performed.
A package-only result is NOT a runtime result. CI owns compiler/profile/producer
provenance and supplies the actual validated Runner payload and metadata.
"""
import argparse
import hashlib
import json
import os
import pathlib
import platform
import resource
import select
import stat
import struct
import subprocess
import tempfile
import time

REPO = pathlib.Path(__file__).resolve().parents[2]
TARGETS = {"x86_64-unknown-linux-musl": ("x86_64", 62),
           "aarch64-unknown-linux-musl": ("aarch64", 183)}
MAX_RUNNER = 128 * 1024 * 1024
MAX_HELPER = 16 * 1024 * 1024
PROFILE = (b"[libdefaults]\n dns_lookup_kdc = false\n dns_lookup_realm = false\n"
           b" rdns = false\n canonicalize = false\n kdc_timesync = 0\n"
           b" default_ccache_name = FILE:/absent\n"
           b" default_client_keytab_name = FILE:/absent\n"
           b" default_keytab_name = FILE:/absent\n")


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def regular(path, limit):
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and 0 < info.st_size <= limit,
            "invalid bounded regular payload")
    return path.read_bytes()


def command(runner, action, destination, limit):
    # Caller runs this script with an explicitly selected UID. Never sudo here.
    # stderr remains private and is not echoed or used as a success classifier.
    with destination.open("xb") as output, tempfile.TemporaryFile(dir=destination.parent) as errors:
        def bound_output():
            resource.setrlimit(resource.RLIMIT_FSIZE, (limit, limit))
        result = subprocess.run([str(runner), "native-kerberos", action],
                                stdout=output, stderr=errors, env={}, timeout=20,
                                preexec_fn=bound_output)
    require(result.returncode == 0, "actual Runner export command refused")
    return regular(destination, limit)


def elf64(data, machine):
    require(len(data) >= 64 and data[:6] == b"\x7fELF\x02\x01",
            "helper must be ELF64 little-endian")
    require(struct.unpack_from("<H", data, 18)[0] == machine,
            "helper ELF target mismatch")
    offset = struct.unpack_from("<Q", data, 32)[0]
    width, count = struct.unpack_from("<HH", data, 54)
    require(width == 56 and 0 < count <= 1024 and offset + width * count <= len(data),
            "helper program headers are invalid")
    for index in range(count):
        kind, _, start, _, _, size, _, _ = struct.unpack_from(
            "<IIQQQQQQ", data, offset + index * width)
        require(start + size <= len(data), "helper segment escaped its payload")
        require(kind != 3, "helper has PT_INTERP")
        if kind == 2:
            require(size % 16 == 0, "invalid helper dynamic segment")
            for cursor in range(start, start + size, 16):
                tag, _ = struct.unpack_from("<qQ", data, cursor)
                require(tag != 1, "helper has DT_NEEDED")
                if tag == 0:
                    break


def frame(process, sequence, deadline):
    def read(size):
        result = bytearray()
        while len(result) < size:
            remaining = deadline - time.monotonic()
            require(remaining > 0, "native protocol deadline exhausted")
            require(select.select([process.stdout], [], [], remaining)[0],
                    "native protocol deadline exhausted")
            part = os.read(process.stdout.fileno(), size - len(result))
            require(part, "native protocol EOF before expected frame")
            result.extend(part)
        return bytes(result)
    header = read(16)
    size, magic, version, kind, reserved, actual = struct.unpack("!I4sBBHI", header)
    require(magic == b"KRB2" and version == 2 and reserved == 0
            and actual == sequence and size <= 131072,
            "invalid actual native frame")
    return kind, read(size)


def send(process, sequence, kind, payload=b""):
    process.stdin.write(struct.pack("!I4sBBHI", len(payload), b"KRB2", 2,
                                    kind, 0, sequence) + payload)
    process.stdin.flush()


def native_probe(helper, work, scenario):
    root = pathlib.Path(tempfile.mkdtemp(prefix="native-", dir=work))
    os.chmod(root, 0o700)
    entries = {}
    process = None
    pidfd = None
    for name, data, mode in [("helper", helper, 0o700),
                             ("profile.conf", PROFILE.replace(b"kdc_timesync = 0",
                              b"kdc_timesync = 1") if scenario == "profile-refusal" else PROFILE, 0o600),
                             ("input.cache", b"", 0o600), ("input.keytab", b"", 0o600)]:
        path = root / name
        with path.open("xb") as output:
            output.write(data)
        path.chmod(mode)
        info = path.lstat()
        entries[name] = (info.st_dev, info.st_ino)
    identity = root.lstat()
    unlinked = False

    def unlink_owned():
        nonlocal unlinked
        if unlinked:
            return
        info = root.lstat()
        require(stat.S_ISDIR(info.st_mode) and (info.st_dev, info.st_ino)
                == (identity.st_dev, identity.st_ino), "native cleanup directory changed")
        require({entry.name for entry in root.iterdir()} == set(entries),
                "native cleanup has unexpected entries")
        for name, expected in entries.items():
            path = root / name
            info = path.lstat()
            require(stat.S_ISREG(info.st_mode) and (info.st_dev, info.st_ino) == expected,
                    "native cleanup file changed")
            path.unlink()
        root.rmdir()
        unlinked = True

    try:
        process = subprocess.Popen([str(root / "helper")], cwd=root, env={},
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=subprocess.DEVNULL, bufsize=0)
        pidfd = os.pidfd_open(process.pid)
        deadline = time.monotonic() + 10
        if scenario == "profile-refusal":
            require(process.wait(timeout=10) != 0 and process.stdout.read(1) == b"",
                    "bad fixed profile did not refuse before Ready")
            result = "refused-before-ready"
        else:
            require(frame(process, 0, deadline) == (0, b""),
                    "invalid secret-free Ready; unsupported bootstrap is not a positive result")
            # Match the production unlink-before-input boundary; no credential
            # bytes exist or are written by these probes.
            unlink_owned()
            if scenario == "invalid-initialize":
                send(process, 1, 1, b"\xff")
                require(frame(process, 1, deadline) == (255, b"\x01"),
                        "malformed public initialize did not refuse")
                require(process.wait(timeout=2) != 0, "invalid initialize did not exit")
                result = "ready-then-invalid-initialize-refused"
            else:
                send(process, 1, 5)
                require(frame(process, 1, deadline) == (19, b""),
                        "native close acknowledgement mismatch")
                require(process.wait(timeout=2) == 0, "native close did not exit cleanly")
                result = "ready-then-close"
            require(process.stdout.read(1) == b"", "unexpected trailing native output")
        require(select.select([pidfd], [], [], 0)[0], "owned native process not terminated")
        unlink_owned()
        require(not root.exists(), "native fixed resource cleanup incomplete")
        return {"scenario": scenario, "outcome": result, "reaped": True,
                "resourcesRemoved": True}
    finally:
        if process is not None:
            if process.poll() is None:
                process.kill()
            process.wait(timeout=2)
            process.stdin.close()
            process.stdout.close()
        if pidfd is not None:
            os.close(pidfd)
        unlink_owned()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runner", required=True, type=pathlib.Path)
    parser.add_argument("--metadata", required=True, type=pathlib.Path)
    parser.add_argument("--provenance", required=True, type=pathlib.Path,
                        help="original asset manifest or compiler-bound release producer record")
    parser.add_argument("--target", required=True, choices=TARGETS)
    parser.add_argument("--profile", required=True, choices=("ci", "release"))
    parser.add_argument("--out", required=True, type=pathlib.Path)
    parser.add_argument("--compiler-receipt", type=pathlib.Path,
                        help="actual Cargo JSON from this release-profile compilation")
    parser.add_argument("--runtime-profile", choices=("privileged-synthetic",))
    args = parser.parse_args()
    host, machine = TARGETS[args.target]
    require(platform.machine() == host, "native target mismatch; emulation is not accepted")
    require(not args.out.exists() and not args.out.is_symlink(), "receipt output must be new")
    require(args.out.parent.is_dir() and args.out.parent.resolve() == args.out.parent.absolute(),
            "receipt ancestor must be canonical and existing")
    runner = args.runner.resolve(strict=True)
    require(not args.runner.is_symlink(), "Runner must not be a symlink")
    payload = regular(runner, MAX_RUNNER)
    metadata = json.loads(regular(args.metadata, 65536))
    require(metadata["target"] == args.target
            and metadata["runnerSha256"] == sha(payload)
            and metadata["runnerSizeBytes"] == len(payload), "Runner identity mismatch")
    # This metadata must come from the existing validated producer/download
    # context; a freshly rehashed arbitrary Runner is not equivalent provenance.
    provenance_bytes = regular(args.provenance, 65536)
    provenance = json.loads(provenance_bytes)
    producer = provenance["producer"]
    require(provenance["target"] == args.target
            and provenance["runner"]["sha256"] == sha(payload)
            and provenance["runner"]["sizeBytes"] == len(payload)
            and producer["repository"] == "okou-ai/okou"
            and type(producer["runId"]) is int and producer["runId"] > 0
            and type(producer["runAttempt"]) is int and producer["runAttempt"] > 0
            and len(producer["headSha"]) == 40
            and all(c in "0123456789abcdef" for c in producer["headSha"]),
            "producer does not bind the actual payload")
    if args.profile == "ci":
        require(provenance["binaryInputDigest"] == metadata["binaryInputDigest"]
                and provenance["toolchainImage"] == metadata["toolchainImage"]
                and producer["workflowPath"] == ".github/workflows/runner-image.yml",
                "CI payload does not bind its transport/build inputs")
    else:
        require(provenance["profile"] == "release" and args.compiler_receipt is not None,
                "release profile requires its own actual compiler receipt")
        compiler_bytes = regular(args.compiler_receipt, 4 * 1024 * 1024)
        require(sha(compiler_bytes) == provenance["compilerReceiptSha256"],
                "release compiler receipt identity mismatch")
        events = [json.loads(line) for line in compiler_bytes.splitlines()]
        artifacts = [event for event in events if event.get("reason") == "compiler-artifact"
                     and event.get("target", {}).get("name") == "runner"
                     and event.get("executable")]
        require(len(artifacts) == 1
                and artifacts[0]["executable"] == provenance["compilerRunnerPath"]
                and artifacts[0]["profile"]["opt_level"] == "3"
                and not artifacts[0]["profile"]["debug_assertions"]
                and not artifacts[0]["profile"]["test"]
                and any(event.get("reason") == "build-finished" and event.get("success") is True
                        for event in events), "release receipt is not an optimized completed Runner build")
    args.out.mkdir(mode=0o700)
    identity = json.loads(command(runner, "identity", args.out / "identity.json", 4096))
    helper = command(runner, "helper", args.out / "helper", MAX_HELPER)
    notices = command(runner, "notices", args.out / "notices.txt", 128 * 1024)
    expected_notices = b"\n".join((REPO / "crates/kerberos-worker/native" / name).read_bytes()
                                 for name in ("NOTICE-MIT", "NOTICE-musl", "NOTICE-Zig"))
    require(identity["nativeTarget"] == args.target
            and identity["helperSha256"] == sha(helper)
            and identity["helperSizeBytes"] == len(helper)
            and identity["noticesSha256"] == sha(notices)
            and identity["noticesSizeBytes"] == len(notices), "sealed package identity mismatch")
    require(helper in payload, "complete exported helper is not in actual Runner")
    require(notices == expected_notices and notices in payload,
            "complete redistribution notices missing from actual Runner/export")
    elf64(helper, machine)
    elf = subprocess.check_output(["readelf", "-h", "-l", "-d", str(args.out / "helper")],
                                  timeout=10)
    (args.out / "elf.txt").write_bytes(elf)
    head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=REPO, text=True).strip()
    dirty = bool(subprocess.check_output(["git", "status", "--porcelain"], cwd=REPO))
    receipt = {"head": head, "worktreeDirty": dirty, "profile": args.profile,
               "profileBinding": "requires matching compiler/consumer context",
               "target": args.target, "runnerSha256": sha(payload),
               "runnerSizeBytes": len(payload), "nativePackage": identity,
               "producerMetadataSha256": sha(args.metadata.read_bytes()),
               "producer": producer, "producerRecordSha256": sha(provenance_bytes),
               "toolchainImage": provenance.get("toolchainImage"),
               "binaryInputDigest": provenance.get("binaryInputDigest"),
               "githubRunId": os.environ.get("GITHUB_RUN_ID"),
               "githubRunAttempt": os.environ.get("GITHUB_RUN_ATTEMPT"),
               "runtimeUid": os.geteuid(), "kernel": platform.release(),
               "runtimeProfile": args.runtime_profile, "runtimeVerified": False,
               "scope": "package inclusion/ELF/notices; optional secret-free native protocol; not authentication, Rust supervisor lifecycle or K3"}
    (args.out / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    if args.runtime_profile:
        require(os.geteuid() == 0, "synthetic profile requires preselected root harness")
        receipt["nativeProbes"] = [native_probe(helper, args.out, scenario) for scenario in
                                   ("close", "profile-refusal", "invalid-initialize")]
        receipt["runtimeVerified"] = True
        (args.out / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps(receipt))


if __name__ == "__main__":
    main()
