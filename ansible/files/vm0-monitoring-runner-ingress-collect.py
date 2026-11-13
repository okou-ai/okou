#!/usr/bin/python3
"""Probe managed Runner HTTPS ingress independently of Runner execution."""

from __future__ import annotations

import argparse
import concurrent.futures
import fcntl
import json
import math
import os
import re
import selectors
import stat
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path

import yaml

RUNNERS_DIR = "/var/lib/vm0-runner/runners"
TEXTFILE_DIR = "/var/lib/vm0-monitoring/textfile-collector"
DIRECTORY_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
FILE_FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC
MAX_FILE_BYTES = 1024 * 1024
MAX_RUNNERS = 128
PROBE_TIMEOUT = 10
COLLECTION_TIMEOUT = 30
PROBE_PERIOD = 60
ATTEMPT_FILE = ".runner-ingress-attempt"
ACTIVE_MODES = ("running", "draining")


def open_directory(path: Path) -> int:
    """Open a trusted directory chain, never following symlinks."""
    if not path.is_absolute() or ".." in path.parts:
        raise ValueError("invalid directory path")
    descriptor = os.open("/", DIRECTORY_FLAGS)
    try:
        for index, part in enumerate(path.parts[1:]):
            child = os.open(part, DIRECTORY_FLAGS, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
            metadata = os.fstat(descriptor)
            final = index == len(path.parts) - 2
            sticky_parent = not final and metadata.st_mode & stat.S_ISVTX
            if metadata.st_uid not in (0, os.geteuid()) or (
                metadata.st_mode & 0o022 and not sticky_parent
            ):
                raise ValueError("unsafe directory")
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def read_file(directory: int, name: str, *, private: bool = False) -> str:
    descriptor = os.open(name, FILE_FLAGS, dir_fd=directory)
    with os.fdopen(descriptor, "rb") as source:
        metadata = os.fstat(source.fileno())
        if (
            not stat.S_ISREG(metadata.st_mode)
            or metadata.st_uid != os.geteuid()
            or metadata.st_mode & (0o077 if private else 0o022)
        ):
            raise ValueError("unsafe input file")
        content = source.read(MAX_FILE_BYTES + 1)
    if len(content) > MAX_FILE_BYTES:
        raise ValueError("input file too large")
    return content.decode("utf-8")


def identity(directory: int) -> tuple[str, int]:
    runner_id = read_file(directory, "runner_id").strip()
    if str(uuid.UUID(runner_id)) != runner_id:
        raise ValueError("invalid runner identity")
    generation = int(read_file(directory, "heartbeat_generation").strip())
    if not 0 < generation <= 9_007_199_254_740_991:
        raise ValueError("invalid runner generation")
    return runner_id, generation


def active(directory: int) -> bool:
    status = json.loads(read_file(directory, "status.json"))
    if not isinstance(status, dict) or not isinstance(status.get("mode"), str):
        raise ValueError("invalid status")
    return status["mode"] in ACTIVE_MODES


def request_health(hostname: str, runner_id: str, token: str, deadline: float) -> bool:
    remaining = min(PROBE_TIMEOUT, deadline - time.monotonic())
    if remaining <= 0:
        return False
    # Disable curlrc, proxies and redirects. Only this provisioned host receives
    # the credential. A pipe keeps the token out of argv, files and diagnostics.
    command = [
        "curl",
        "--disable",
        "--silent",
        "--proto",
        "=https",
        "--noproxy",
        "*",
        "--max-time",
        str(remaining),
        "--max-filesize",
        "2",
        "--config",
        "-",
        "--write-out",
        "%{stderr}%{http_code}",
        f"https://{hostname}/runners/{runner_id}/control/health",
    ]
    header = json.dumps(f"Authorization: Bearer {token}")
    process = subprocess.Popen(
        command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE
    )
    try:
        assert process.stdin is not None
        assert process.stdout is not None
        assert process.stderr is not None
        process.stdin.write(f"header = {header}\n".encode("ascii"))
        process.stdin.close()
        expires = min(deadline, time.monotonic() + remaining)
        output = {"body": bytearray(), "status": bytearray()}
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ, "body")
            selector.register(process.stderr, selectors.EVENT_READ, "status")
            while selector.get_map():
                budget = expires - time.monotonic()
                if budget <= 0:
                    return False
                for key, _ in selector.select(budget):
                    chunk = os.read(key.fd, 4)
                    if not chunk:
                        selector.unregister(key.fileobj)
                        continue
                    output[key.data].extend(chunk)
                    limit = 2 if key.data == "body" else 3
                    if len(output[key.data]) > limit:
                        return False
        code = process.wait(timeout=max(0, expires - time.monotonic()))
        return code == 0 and output["status"] == b"200" and output["body"] == b"ok"
    except (OSError, subprocess.TimeoutExpired):
        return False
    finally:
        if process.poll() is None:
            process.kill()
        process.wait()
        try:
            process.stdin.close()
        except OSError:
            pass
        process.stdout.close()
        process.stderr.close()


def probe_runner(
    path: Path,
    hostname: str,
    deadline: float,
    seen: set[str],
    identity_lock: threading.Lock,
) -> tuple[str, int] | None:
    runner_id = None
    directory = None
    try:
        directory = open_directory(path)
        if not active(directory):
            return None
        original = identity(directory)
        runner_id = original[0]
        config = yaml.safe_load(read_file(directory, "runner.yaml", private=True))
        if not isinstance(config, dict):
            raise ValueError("invalid configuration")
        server = config.get("server")
        if server is None:
            return None
        if not isinstance(server, dict) or not isinstance(server.get("token"), str):
            raise ValueError("invalid server configuration")
        token = server["token"]
        if not token.startswith("vm0_official_"):
            return None
        if (
            len(token) != len("vm0_official_") + 64
            or any(not 0x21 <= ord(char) <= 0x7E for char in token)
            or config.get("hostname") != hostname
            or config.get("base_dir") != str(path)
        ):
            raise ValueError("invalid managed ingress configuration")
        with identity_lock:
            if runner_id in seen:
                return runner_id, 0
            seen.add(runner_id)
        reachable = request_health(hostname, runner_id, token, deadline)
        # A restart while the request is in flight cannot inherit its success.
        unchanged = original == identity(directory)
        if not active(directory):
            return None
        return runner_id, int(reachable and unchanged)
    except FileNotFoundError:
        # Prepared versions have no status/identity yet. A disappearing target
        # with a known identity cannot extend an earlier healthy observation.
        return (runner_id, 0) if runner_id is not None else None
    except (OSError, ValueError, TypeError, yaml.YAMLError):
        # YAML exceptions can quote secrets. Never print parser input/errors.
        print("Runner ingress input unavailable or invalid", file=sys.stderr)
        return (runner_id, 0) if runner_id is not None else None
    finally:
        if directory is not None:
            os.close(directory)


def collect(runners_dir: Path, hostname: str, deadline: float) -> dict[str, int]:
    try:
        directory = open_directory(runners_dir)
    except FileNotFoundError:
        return {}
    try:
        names = []
        with os.scandir(directory) as entries:
            for entry in entries:
                if len(names) >= MAX_RUNNERS or time.monotonic() >= deadline:
                    raise ValueError("runner discovery budget exceeded")
                if entry.is_dir(follow_symlinks=False):
                    names.append(entry.name)
    finally:
        os.close(directory)
    results: dict[str, int] = {}
    seen: set[str] = set()
    identity_lock = threading.Lock()
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as executor:
        futures = [
            executor.submit(
                probe_runner,
                runners_dir / name,
                hostname,
                deadline,
                seen,
                identity_lock,
            )
            for name in sorted(names)
        ]
        for future in concurrent.futures.as_completed(futures):
            result = future.result()
            if result is not None:
                runner_id, reachable = result
                # Conflicting discovery must never publish duplicate samples or
                # select whichever identity happened to finish first.
                results[runner_id] = 0 if runner_id in results else reachable
    return results


def publish(directory_path: Path, results: dict[str, int]) -> None:
    directory = open_directory(directory_path)
    temporary = f".runner-ingress.{uuid.uuid4().hex}.tmp"
    try:
        descriptor = os.open(
            temporary,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
            0o644,
            dir_fd=directory,
        )
        with os.fdopen(descriptor, "w") as output:
            os.fchmod(output.fileno(), 0o644)
            output.write(
                "# HELP vm0_runner_ingress_up Authenticated HTTPS Runner health succeeded.\n"
            )
            output.write("# TYPE vm0_runner_ingress_up gauge\n")
            for runner_id, reachable in sorted(results.items()):
                output.write(
                    f'vm0_runner_ingress_up{{runner_id="{runner_id}"}} {reachable}\n'
                )
            output.flush()
            os.fsync(output.fileno())
        os.replace(
            temporary, "runner-ingress.prom", src_dir_fd=directory, dst_dir_fd=directory
        )
        os.fsync(directory)
    finally:
        try:
            os.unlink(temporary, dir_fd=directory)
        except FileNotFoundError:
            pass
        os.close(directory)


def write_schedule(descriptor: int, boot_id: str, not_before: float) -> None:
    content = json.dumps([boot_id, not_before]).encode("ascii")
    os.lseek(descriptor, 0, os.SEEK_SET)
    os.ftruncate(descriptor, 0)
    if os.write(descriptor, content) != len(content):
        raise OSError("incomplete ingress schedule write")
    os.fsync(descriptor)


def begin_round(directory_path: Path) -> tuple[int, str, float] | None:
    directory = open_directory(directory_path)
    try:
        descriptor = os.open(
            ATTEMPT_FILE,
            os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC,
            0o600,
            dir_fd=directory,
        )
    finally:
        os.close(directory)
    try:
        metadata = os.fstat(descriptor)
        if (
            not stat.S_ISREG(metadata.st_mode)
            or metadata.st_uid != os.geteuid()
            or metadata.st_mode & 0o077
        ):
            raise ValueError("unsafe ingress schedule")
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            os.close(descriptor)
            return None
        content = os.read(descriptor, 129)
        boot_id = Path("/proc/sys/kernel/random/boot_id").read_text().strip()
        now = time.monotonic()
        if content:
            saved = json.loads(content)
            if (
                len(content) > 128
                or not isinstance(saved, list)
                or len(saved) != 2
                or not isinstance(saved[0], str)
                or type(saved[1]) not in (int, float)
                or not math.isfinite(saved[1])
            ):
                raise ValueError("invalid ingress schedule")
            if saved[0] == boot_id and now < saved[1]:
                os.close(descriptor)
                return None
        # Reserve before network I/O. Even a killed round cannot immediately
        # retry: all requests have this round's 30-second deadline.
        deadline = now + COLLECTION_TIMEOUT
        write_schedule(descriptor, boot_id, deadline + PROBE_PERIOD)
        return descriptor, boot_id, deadline
    except BaseException:
        os.close(descriptor)
        raise


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--hostname", required=True)
    args = parser.parse_args()
    labels = args.hostname.split(".")
    if (
        len(args.hostname) > 253
        or len(labels) < 2
        or not all(
            re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label)
            for label in labels
        )
    ):
        parser.error("a canonical inventory hostname is required")
    runners_dir = Path(os.environ.get("OKOU_RUNNERS_DIR") or RUNNERS_DIR)
    textfile_dir = Path(os.environ.get("OKOU_MONITORING_TEXTFILE_DIR") or TEXTFILE_DIR)
    try:
        slot = begin_round(textfile_dir)
    except (OSError, ValueError):
        print("Runner ingress schedule unavailable", file=sys.stderr)
        raise SystemExit(1) from None
    if slot is None:
        return
    descriptor, boot_id, deadline = slot
    try:
        try:
            results = collect(runners_dir, args.hostname, deadline)
        except (OSError, ValueError):
            print("Runner ingress discovery unavailable", file=sys.stderr)
            results = {}
        publish(textfile_dir, results)
    finally:
        try:
            # Publication failure still waits a full period before more probes.
            write_schedule(descriptor, boot_id, time.monotonic() + PROBE_PERIOD)
        finally:
            os.close(descriptor)


if __name__ == "__main__":
    main()
