#!/usr/bin/env python3
"""Observe/reconcile PR resources on one host; GitHub authority stays in the caller.

The session worker owns every selected namespace's lifecycle lock through cleanup.
Input is an explicit PR-number selection, never paths or shell fragments. Output
is JSON; command errors go to stderr. No mutation is replayed after a timeout.
--root relocates filesystem access for execution in an isolated host namespace.
"""

import argparse
import contextlib
import fcntl
import json
import os
import queue
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path, PurePosixPath

UNIT = re.compile(
    r"^(?:vm0-runner-pr-([1-9][0-9]*)(?:-[a-z0-9][a-z0-9.-]*)?|vm0-stripe-listener-pr-([1-9][0-9]*))\.service$"
)
NAMESPACE = re.compile(r"(?:^|-)pr-([1-9][0-9]*)(?:-|$)")
PROPERTIES = (
    "Id",
    "LoadState",
    "ActiveState",
    "MainPID",
    "ControlGroup",
    "FragmentPath",
)
UNIT_ROOTS = ("/etc/systemd/system", "/run/systemd/system", "/run/systemd/transient")
DATA_ROOTS = (
    "/var/lib/vm0-runner/bin",
    "/var/lib/vm0-runner/runners",
    "/var/lib/vm0-runner/groups/vm0",
    "/var/lib/vm0-runner/stripe",
)


def command(*args, allow_failure=False):
    result = subprocess.run(
        args, capture_output=True, text=True, timeout=35, check=False
    )
    if result.returncode and not allow_failure:
        raise RuntimeError(f"{args[0]} {args[1]} failed: {result.stderr.strip()}")
    return result


class Host:
    def __init__(self, root):
        self.root = Path(root).resolve()

    def path(self, absolute):
        return self.root / absolute.lstrip("/")

    def entries(self, absolute):
        directory = self.path(absolute)
        if directory.is_symlink():
            raise RuntimeError(f"managed root is a symlink: {absolute}")
        try:
            return list(directory.iterdir())
        except FileNotFoundError:
            return []

    def populated(self, group):
        if not group:
            return False
        path = PurePosixPath(group)
        if not path.is_absolute() or ".." in path.parts:
            raise RuntimeError("invalid systemd cgroup path")
        try:
            events = dict(
                line.split()
                for line in self.path("/sys/fs/cgroup" + group + "/cgroup.events")
                .read_text()
                .splitlines()
            )
        except FileNotFoundError:
            return False
        if events.get("populated") not in {"0", "1"}:
            raise RuntimeError(f"cannot establish cgroup population: {group}")
        return events["populated"] == "1"

    def states(self, names):
        states = {}
        names = sorted(names)
        for offset in range(0, len(names), 100):
            selected = names[offset : offset + 100]
            result = command(
                "systemctl",
                "show",
                "--all",
                "--no-pager",
                "--property=" + ",".join(PROPERTIES),
                *selected,
                allow_failure=True,
            )
            for block in result.stdout.strip().split("\n\n"):
                fields = dict(
                    line.split("=", 1) for line in block.splitlines() if "=" in line
                )
                if fields.get("Id") not in selected or any(
                    key not in fields for key in PROPERTIES
                ):
                    raise RuntimeError("incomplete systemd unit state")
                if fields["LoadState"] not in {
                    "loaded",
                    "not-found",
                    "masked",
                    "error",
                    "bad-setting",
                    "stub",
                    "merged",
                }:
                    raise RuntimeError("unknown systemd load state")
                fields["busy"] = (
                    fields["ActiveState"] not in {"inactive", "failed"}
                    or int(fields["MainPID"]) != 0
                    or self.populated(fields["ControlGroup"])
                )
                states[fields["Id"]] = fields
            if any(name not in states for name in selected):
                raise RuntimeError("systemd omitted a requested unit")
            # A mixed query can return nonzero because one unit is missing.
            # Every requested state must still be explicit and complete.
            if result.returncode and not (
                result.returncode in {1, 4}
                and any(states[name]["LoadState"] == "not-found" for name in selected)
            ):
                raise RuntimeError(
                    f"systemd state query failed: {result.stderr.strip()}"
                )
        return states

    def inventory(self, selected=None):
        selected = None if selected is None else set(selected)
        units = {}
        directories = {}

        def wanted(pr):
            return selected is None or pr in selected

        def add_unit(name, file=None):
            match = UNIT.fullmatch(name)
            if not match:
                return
            pr = int(match[1] or match[2])
            if wanted(pr):
                units.setdefault(name, {"pr": pr, "paths": []})
                if file is not None:
                    units[name]["paths"].append(str(file))

        patterns = (
            ["vm0-runner-pr-*", "vm0-stripe-listener-pr-*"]
            if selected is None
            else [
                pattern
                for pr in sorted(selected)
                for pattern in (
                    f"vm0-runner-pr-{pr}-*",
                    f"vm0-runner-pr-{pr}.service",
                    f"vm0-stripe-listener-pr-{pr}.service",
                )
            ]
        )
        loaded = command(
            "systemctl",
            "list-units",
            "--all",
            "--type=service",
            "--no-legend",
            "--plain",
            "--no-pager",
            *patterns,
        )
        for line in loaded.stdout.splitlines():
            if line.strip():
                add_unit(line.split()[0])

        for root in UNIT_ROOTS:
            for entry in self.entries(root):
                add_unit(entry.name, entry)
                if entry.name.endswith(".service.d"):
                    add_unit(entry.name[:-2], entry)
                elif entry.name.endswith((".wants", ".requires")):
                    if entry.is_symlink():
                        raise RuntimeError(
                            f"unit dependency directory is a symlink: {entry}"
                        )
                    for link in entry.iterdir():
                        add_unit(link.name, link)

        for root in DATA_ROOTS:
            for entry in self.entries(root):
                match = NAMESPACE.search(entry.name)
                # Group names have a descriptive prefix; all other roots use
                # an exact leading PR identity. Never match pr-42 with pr-420.
                if match and ("/groups/" in root or entry.name.startswith("pr-")):
                    pr = int(match[1])
                    if wanted(pr):
                        directories.setdefault(pr, []).append(str(entry))

        states = self.states(units)
        resources = {}
        for name, resource in units.items():
            state = states[name]
            resource.update(name=name, state=state)
            fragment = state["FragmentPath"]
            if fragment and (
                not fragment.startswith("/") or ".." in PurePosixPath(fragment).parts
            ):
                raise RuntimeError("invalid unit fragment path")
            fragment_exists = bool(
                fragment
                and (self.path(fragment).exists() or self.path(fragment).is_symlink())
            )
            actionable = bool(
                resource["paths"]
                or fragment_exists
                or state["busy"]
                or state["ActiveState"] == "failed"
            )
            if actionable:
                resources.setdefault(resource["pr"], {"units": [], "directories": []})[
                    "units"
                ].append(resource)
        for pr, paths in directories.items():
            resources.setdefault(pr, {"units": [], "directories": []})[
                "directories"
            ] = paths
        return resources

    def remove(self, path):
        path = Path(path)
        # Paths originate only in the bounded inventory. Reject symlinked
        # ancestors even if a concurrent native caller changed one after scan.
        for parent in path.parents:
            if parent == self.root:
                break
            if parent.is_symlink():
                raise RuntimeError(f"resource ancestor is a symlink: {parent}")
        try:
            if path.is_symlink() or not path.is_dir():
                path.unlink()
            else:
                shutil.rmtree(path)
        except FileNotFoundError:
            pass

    @contextlib.contextmanager
    def reload_lock(self):
        directory = self.path("/var/lib/vm0-runner/locks")
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        lock = directory / "systemd-daemon-reload.lock"
        with lock.open("a") as handle:
            deadline = time.monotonic() + 30
            while True:
                try:
                    fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    if time.monotonic() >= deadline:
                        raise TimeoutError("systemd reload lock deadline exceeded")
                    time.sleep(0.1)
            yield

    def cleanup(self, selected):
        before = self.inventory(selected)
        outcomes = {}
        dirty = False
        for pr in selected:
            resource = before.get(pr, {"units": [], "directories": []})
            try:
                names = [unit["name"] for unit in resource["units"]]
                if names:
                    command(
                        "systemctl", "stop", "--no-block", *names, allow_failure=True
                    )
                    deadline = time.monotonic() + 60
                    while any(state["busy"] for state in self.states(names).values()):
                        if time.monotonic() >= deadline:
                            raise TimeoutError("service execution remains after stop")
                        time.sleep(0.5)
                    command(
                        "systemctl",
                        "disable",
                        "--no-reload",
                        *names,
                        allow_failure=True,
                    )
                    # Clearing failed metadata allows systemd to collect units
                    # whose files were already removed by a previous teardown.
                    command("systemctl", "reset-failed", *names, allow_failure=True)
                for unit in resource["units"]:
                    for path in unit["paths"]:
                        dirty = True
                        self.remove(path)
                for path in resource["directories"]:
                    self.remove(path)
                outcomes[pr] = {
                    "outcome": "cleaned"
                    if resource["units"] or resource["directories"]
                    else "already_absent",
                    "units": len(resource["units"]),
                    "directories": len(resource["directories"]),
                }
            except (
                OSError,
                RuntimeError,
                ValueError,
                subprocess.SubprocessError,
            ) as error:
                outcomes[pr] = {"outcome": "failed", "error": str(error)}
        if dirty:
            try:
                with self.reload_lock():
                    command("systemctl", "daemon-reload")
            except (OSError, RuntimeError, subprocess.SubprocessError) as error:
                return {
                    pr: {"outcome": "unverified", "error": str(error)}
                    for pr in selected
                }
        try:
            remaining = self.inventory(selected)
        except (OSError, RuntimeError, ValueError, subprocess.SubprocessError) as error:
            return {
                pr: {"outcome": "unverified", "error": str(error)} for pr in selected
            }
        for pr, resource in remaining.items():
            outcomes[pr] = {
                "outcome": "failed",
                "error": "resources remain after cleanup",
                "remaining": resource,
            }
        return outcomes

    def session(self, numbers):
        """Own the locks in the same process that performs the mutation.

        EOF or an expired heartbeat interrupts the main thread. subprocess.run
        retires its current command before ExitStack releases our flock FDs.
        Current Bash-based creators use these exact same host-local lock files.
        """
        messages = queue.Queue()
        finished = threading.Event()
        last_seen = [time.monotonic()]

        def receive():
            try:
                for line in sys.stdin:
                    message = json.loads(line)
                    last_seen[0] = time.monotonic()
                    if message["operation"] != "heartbeat":
                        messages.put(message)
            finally:
                if not finished.is_set():
                    os.kill(os.getpid(), signal.SIGTERM)

        def lease():
            while not finished.wait(1):
                if time.monotonic() - last_seen[0] > 150:
                    os.kill(os.getpid(), signal.SIGTERM)
                    return

        receiver = threading.Thread(target=receive, daemon=True)
        watchdog = threading.Thread(target=lease, daemon=True)
        receiver.start()
        watchdog.start()
        try:
            with contextlib.ExitStack() as locks:
                directory = self.path("/var/lock")
                directory.mkdir(parents=True, exist_ok=True)
                deadline = time.monotonic() + 60
                for number in numbers:
                    handle = locks.enter_context(
                        (directory / f"vm0-runner-lifecycle-pr-{number}.lock").open("a")
                    )
                    while True:
                        try:
                            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                            break
                        except BlockingIOError:
                            if time.monotonic() >= deadline:
                                raise TimeoutError(
                                    "namespace lock acquisition deadline exceeded"
                                )
                            time.sleep(0.1)
                print(json.dumps({"ready": numbers}), flush=True)
                while True:
                    message = messages.get()
                    if message["operation"] == "release":
                        finished.set()
                        break
                    if message["operation"] != "cleanup":
                        raise RuntimeError("invalid reconciliation operation")
                    selected = message["numbers"]
                    if not selected or any(
                        type(number) is not int or number not in numbers
                        for number in selected
                    ):
                        raise RuntimeError(
                            "cleanup selection is outside the locked namespaces"
                        )
                    signal.alarm(120)
                    try:
                        result = self.cleanup(selected)
                    finally:
                        signal.alarm(0)
                    print(
                        json.dumps({"results": result}, separators=(",", ":")),
                        flush=True,
                    )
        finally:
            finished.set()
        # A release receipt is written only after the lock descriptors close.
        print(json.dumps({"released": True}), flush=True)
        # The controller closes stdin after that receipt. Let the buffered
        # reader finish before interpreter shutdown, without keeping locks held.
        receiver.join(timeout=2)
        watchdog.join(timeout=2)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=["inventory", "session"])
    parser.add_argument("numbers", nargs="*", type=int)
    parser.add_argument("--root", default="/")
    args = parser.parse_args()
    if any(number <= 0 for number in args.numbers) or (
        args.operation == "session" and not args.numbers
    ):
        parser.error("cleanup requires positive PR numbers")
    host = Host(args.root)
    if args.operation == "session":
        if len(args.numbers) > 8:
            parser.error("session batch exceeds eight namespaces")
        signal.alarm(0)
        host.session(sorted(set(args.numbers)))
        return
    result = host.inventory(args.numbers or None)
    print(json.dumps(result, separators=(",", ":")))


if __name__ == "__main__":

    def cancel(signum, _frame):
        raise SystemExit(128 + signum)

    signal.signal(signal.SIGTERM, cancel)
    signal.signal(signal.SIGHUP, cancel)

    def deadline(_signum, _frame):
        print("host reconciliation deadline exceeded", file=sys.stderr)
        # Escape per-namespace recovery: this one-shot alarm is the entire
        # worker's deadline, not another item failure to continue past.
        raise SystemExit(124)

    # The remote operation is shorter than the caller's transport deadline.
    # Interrupting subprocess.run also terminates/reaps its current systemctl.
    signal.signal(signal.SIGALRM, deadline)
    signal.alarm(120)
    try:
        main()
    except (OSError, RuntimeError, ValueError, subprocess.SubprocessError) as error:
        print(f"metal resource observation failed: {error}", file=sys.stderr)
        sys.exit(1)
