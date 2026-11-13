#!/usr/bin/python3
"""Collect local Runner lifecycle or authenticated HTTPS ingress metrics."""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import os
import re
import selectors
import stat
import subprocess
import sys
import threading
import time
import uuid
from collections import Counter
from pathlib import Path

import yaml

SANDBOX_STATES = ("active", "idle", "blank", "preparing", "unknown")
RUNNER_MODES = ("starting", "running", "draining", "stopping", "unknown")
STATUS_RESULTS = ("included", "stopped", "invalid")
STATE_PRECEDENCE = {"blank": -1, "unknown": 0, "preparing": 1, "active": 2, "idle": 3}
CANONICAL_RUNNERS_DIR_ENV = "OKOU_RUNNERS_DIR"
DEFAULT_RUNNERS_DIR = "/var/lib/vm0-runner/runners"
CANONICAL_TEXTFILE_DIR_ENV = "OKOU_MONITORING_TEXTFILE_DIR"
DEFAULT_TEXTFILE_DIR = "/var/lib/vm0-monitoring/textfile-collector"


class InvalidStatus(ValueError):
    pass


def parse_sandbox_entry(entry: object) -> tuple[dict[object, object], str]:
    if not isinstance(entry, dict):
        raise InvalidStatus("sandbox entry must be an object")

    value = entry.get("sandbox_id")
    if not isinstance(value, str):
        raise InvalidStatus("sandbox_id must be a string")

    try:
        return entry, str(uuid.UUID(value))
    except ValueError as error:
        raise InvalidStatus("sandbox_id must be a UUID") from error


def parse_collection(status: dict[object, object], field: str) -> list[object]:
    value = status.get(field, [])
    if not isinstance(value, list):
        raise InvalidStatus(f"{field} must be an array")
    return value


def parse_status_object(content: str) -> tuple[dict[object, object], str]:
    status = json.loads(content)
    if not isinstance(status, dict):
        raise InvalidStatus("status must be an object")
    mode = status.get("mode")
    if not isinstance(mode, str) or not mode:
        raise InvalidStatus("mode must be a non-empty string")
    return status, mode


def parse_status(path: Path) -> tuple[str, list[tuple[str, str]]]:
    status, mode = parse_status_object(path.read_text(encoding="utf-8"))

    if mode == "stopped":
        return mode, []

    sandbox_states: list[tuple[str, str]] = []
    for entry in parse_collection(status, "active_runs"):
        active_run, sandbox_id = parse_sandbox_entry(entry)
        if "phase" not in active_run:
            state = "active"
        else:
            phase = active_run["phase"]
            if not isinstance(phase, str):
                raise InvalidStatus("active run phase must be a string")
            state = {"running": "active", "preparing": "preparing"}.get(
                phase, "unknown"
            )
        sandbox_states.append((sandbox_id, state))

    blank_ids = {
        parse_sandbox_entry(entry)[1]
        for entry in parse_collection(status, "blank_sandboxes")
    }
    for entry in parse_collection(status, "idle_sandboxes"):
        _, sandbox_id = parse_sandbox_entry(entry)
        if sandbox_id not in blank_ids:
            sandbox_states.append((sandbox_id, "idle"))
    sandbox_states.extend((sandbox_id, "blank") for sandbox_id in blank_ids)

    return mode, sandbox_states


def record_state(states: dict[str, str], sandbox_id: str, state: str) -> None:
    current = states.get(sandbox_id)
    if current is None or STATE_PRECEDENCE[state] > STATE_PRECEDENCE[current]:
        states[sandbox_id] = state


def collect_status(
    runners_dir: Path,
) -> tuple[Counter[str], Counter[str], Counter[str], int]:
    sandbox_states: dict[str, str] = {}
    runner_modes: Counter[str] = Counter()
    status_results: Counter[str] = Counter()
    collection_success = 1

    if runners_dir.is_symlink():
        print(f"invalid runners directory symlink: {runners_dir}", file=sys.stderr)
        return Counter(), runner_modes, status_results, 0

    if not runners_dir.exists():
        return Counter(), runner_modes, status_results, collection_success

    if not runners_dir.is_dir():
        print(f"invalid runners directory: {runners_dir}", file=sys.stderr)
        return Counter(), runner_modes, status_results, 0

    try:
        runner_dirs = sorted(runners_dir.iterdir(), key=lambda path: path.name)
    except OSError as error:
        print(f"cannot scan runners directory {runners_dir}: {error}", file=sys.stderr)
        return Counter(), runner_modes, status_results, 0

    for runner_dir in runner_dirs:
        if runner_dir.is_symlink():
            print(f"invalid runner directory symlink: {runner_dir}", file=sys.stderr)
            status_results["invalid"] += 1
            collection_success = 0
            continue
        if not runner_dir.is_dir():
            continue

        status_path = runner_dir / "status.json"
        if status_path.is_symlink():
            print(f"invalid status file symlink: {status_path}", file=sys.stderr)
            status_results["invalid"] += 1
            collection_success = 0
            continue
        if not status_path.exists():
            continue
        if not status_path.is_file():
            print(f"invalid status file: {status_path}", file=sys.stderr)
            status_results["invalid"] += 1
            collection_success = 0
            continue

        try:
            mode, entries = parse_status(status_path)
        except (OSError, UnicodeError, json.JSONDecodeError, InvalidStatus) as error:
            print(f"invalid runner status {status_path}: {error}", file=sys.stderr)
            status_results["invalid"] += 1
            collection_success = 0
            continue

        if mode == "stopped":
            status_results["stopped"] += 1
            continue

        status_results["included"] += 1
        runner_modes[mode if mode in RUNNER_MODES else "unknown"] += 1
        for sandbox_id, state in entries:
            record_state(sandbox_states, sandbox_id, state)

    return (
        Counter(sandbox_states.values()),
        runner_modes,
        status_results,
        collection_success,
    )


def render_status_metrics(
    sandbox_states: Counter[str],
    runner_modes: Counter[str],
    status_results: Counter[str],
    collection_success: int,
) -> str:
    lines = [
        "# HELP vm0_runner_sandboxes Runner-managed sandboxes by lifecycle state.",
        "# TYPE vm0_runner_sandboxes gauge",
    ]
    lines.extend(
        f'vm0_runner_sandboxes{{state="{state}"}} {sandbox_states[state]}'
        for state in SANDBOX_STATES
    )
    lines.extend(
        [
            "",
            "# HELP vm0_runner_instances Live runner instances by lifecycle mode.",
            "# TYPE vm0_runner_instances gauge",
        ]
    )
    lines.extend(
        f'vm0_runner_instances{{mode="{mode}"}} {runner_modes[mode]}'
        for mode in RUNNER_MODES
    )
    lines.extend(
        [
            "",
            "# HELP vm0_runner_status_files Runner status files by collection result.",
            "# TYPE vm0_runner_status_files gauge",
        ]
    )
    lines.extend(
        f'vm0_runner_status_files{{result="{result}"}} {status_results[result]}'
        for result in STATUS_RESULTS
    )
    lines.extend(
        [
            "",
            "# HELP vm0_runner_status_collection_success Whether all runner status inputs were collected successfully.",
            "# TYPE vm0_runner_status_collection_success gauge",
            f"vm0_runner_status_collection_success {collection_success}",
        ]
    )
    return "\n".join(lines) + "\n"


DIRECTORY_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
FILE_FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC
MAX_FILE_BYTES = 1024 * 1024
MAX_RUNNERS = 128
PROBE_TIMEOUT = 10
COLLECTION_TIMEOUT = 30
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
    _, mode = parse_status_object(read_file(directory, "status.json"))
    return mode in ACTIVE_MODES


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
            # A failed curl may already have closed its credential pipe.
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


def collect_ingress(
    runners_dir: Path, hostname: str, deadline: float
) -> dict[str, int]:
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


def render_ingress_metrics(results: dict[str, int] | None) -> str:
    lines = []
    for outcome, value in (("success", 1), ("failure", 0)):
        metric = f"vm0_runner_ingress_{outcome}_count"
        lines.extend(
            [
                f"# HELP {metric} Unique Runner targets with {outcome} in the latest HTTPS health round.",
                f"# TYPE {metric} gauge",
            ]
        )
        if results is not None:
            count = sum(result == value for result in results.values())
            lines.append(f"{metric} {count}")
    return "\n".join(lines) + "\n"


def write_metrics(textfile_dir: Path, filename: str, metrics: str) -> None:
    if not textfile_dir.is_dir():
        raise FileNotFoundError(f"missing textfile directory: {textfile_dir}")
    directory = open_directory(textfile_dir)
    temporary = f".{filename}.{uuid.uuid4().hex}.tmp"
    try:
        descriptor = os.open(
            temporary,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
            0o644,
            dir_fd=directory,
        )
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            os.fchmod(output.fileno(), 0o644)
            output.write(metrics)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, filename, src_dir_fd=directory, dst_dir_fd=directory)
        os.fsync(directory)
    finally:
        try:
            os.unlink(temporary, dir_fd=directory)
        except FileNotFoundError:
            # Successful atomic replacement already consumed the staging name.
            pass
        os.close(directory)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_subparsers(dest="mode", required=True)
    modes.add_parser("status", help="collect local lifecycle metrics")
    ingress = modes.add_parser("ingress", help="probe authenticated HTTPS health")
    ingress.add_argument("--hostname", required=True)
    args = parser.parse_args()
    runners_dir = Path(os.environ.get(CANONICAL_RUNNERS_DIR_ENV) or DEFAULT_RUNNERS_DIR)
    textfile_dir = Path(
        os.environ.get(CANONICAL_TEXTFILE_DIR_ENV) or DEFAULT_TEXTFILE_DIR
    )
    if args.mode == "status":
        metrics = render_status_metrics(*collect_status(runners_dir))
        filename = "runner-status.prom"
    else:
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
        try:
            results = collect_ingress(
                runners_dir, args.hostname, time.monotonic() + COLLECTION_TIMEOUT
            )
        except (OSError, ValueError):
            print("Runner ingress discovery unavailable", file=sys.stderr)
            # Unavailable discovery is not a successful empty collection.
            results = None
        metrics = render_ingress_metrics(results)
        filename = "runner-ingress.prom"
    write_metrics(textfile_dir, filename, metrics)


if __name__ == "__main__":
    main()
