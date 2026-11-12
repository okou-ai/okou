#!/usr/bin/env python3
"""Reconcile closed-PR metal resources in bounded all-host locked batches.

Required: GH_TOKEN, GITHUB_REPOSITORY, GITHUB_RUN_ID, METAL_HOSTS, METAL_USER.
Optional: RUNNER_PR_NUMBERS (comma-separated selection), DRY_RUN=true.
The same command handles scheduled and close-event cleanup. Remote observations
and outcomes are JSON, diagnostics are stderr, and unresolved outcomes exit 1.
SIGINT/SIGTERM/SIGHUP retire owned commands and exit 128 + signal number.
"""

import argparse
import base64
import json
import os
import re
import select
import shlex
import signal
import subprocess
import sys
import threading
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
# Keep authority snapshots fresh and bound how long any namespace is held.
BATCH_SIZE = 8
OWNER_PATHS = {
    ".github/workflows/turbo.yml",
    ".github/workflows/crates.yml",
    ".github/workflows/runner-image.yml",
}
ACTIVE_STATUSES = ("queued", "in_progress", "pending", "waiting", "requested")
# Repository run searches, including status filters, are capped by GitHub.
RUN_SEARCH_LIMIT = 1000
CHILDREN = set()
CANCELLED = threading.Event()


def run(args, *, input=None, timeout=120, env=None):
    # Own the entire process group: SSH and the established nested lock helpers
    # have children that must not survive cancellation of this controller.
    with subprocess.Popen(
        args,
        stdin=subprocess.PIPE if input is not None else subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=None,
        text=True,
        start_new_session=True,
        env=env,
    ) as process:
        CHILDREN.add(process.pid)
        try:
            if CANCELLED.is_set():
                raise SystemExit(143)
            output, _ = process.communicate(input, timeout=timeout)
        except BaseException:
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                # It already exited; communicate below still reaps it.
                pass
            try:
                process.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.communicate()
            raise
        finally:
            CHILDREN.discard(process.pid)
        if process.returncode:
            raise RuntimeError(
                f"{Path(args[0]).name} exited {process.returncode}; see command diagnostics"
            )
        return output


def gh(*args):
    return json.loads(run(["gh", "api", *args], timeout=90))


class GitHub:
    def __init__(self, repository):
        if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository):
            raise ValueError("invalid repository")
        self.repository = repository
        self.requests = 0
        self.associations = {}

    def query(self, *args):
        response = gh(*args)
        self.requests += len(response) if "--slurp" in args else 1
        return response

    def pulls(self, numbers):
        owner, repository = self.repository.split("/")
        result = {}
        for offset in range(0, len(numbers), 50):
            selected = numbers[offset : offset + 50]
            fields = " ".join(
                f"p{number}:pullRequest(number:{number}){{number state createdAt closedAt headRefName headRepository{{nameWithOwner}}}}"
                for number in selected
            )
            query = (
                f'query{{repository(owner:"{owner}",name:"{repository}"){{{fields}}}}}'
            )
            response = self.query("graphql", "-f", "query=" + query)
            if response.get("errors"):
                raise RuntimeError("GitHub PR-state query returned errors")
            pulls = response["data"]["repository"]
            for number in selected:
                pull = pulls[f"p{number}"]
                if (
                    pull is None
                    or pull["number"] != number
                    or pull["state"] not in {"OPEN", "CLOSED", "MERGED"}
                ):
                    raise RuntimeError(f"cannot resolve PR #{number}")
                result[number] = pull
        return result

    def status_runs(self, status):
        previous = None
        for _ in range(2):
            pages = self.query(
                "--method",
                "GET",
                f"repos/{self.repository}/actions/runs",
                "-f",
                f"status={status}",
                "-f",
                "per_page=100",
                "--paginate",
                "--slurp",
            )
            if not pages:
                raise RuntimeError(f"owner discovery returned no page for {status}")
            records = {
                record["id"]: record
                for page in pages
                for record in page["workflow_runs"]
            }
            reported = max(page["total_count"] for page in pages)
            if reported >= RUN_SEARCH_LIMIT:
                raise RuntimeError(
                    f"owner discovery coverage unverified for {status}: "
                    f"{len(records)} returned, {reported} reported; "
                    f"GitHub search limit {RUN_SEARCH_LIMIT} reached"
                )
            if len(records) >= reported:
                break
            if previous is not None:
                raise RuntimeError(
                    f"owner discovery coverage unverified for {status} after recheck: "
                    f"{len(records)} returned, {reported} reported"
                )
            # Page totals and run statuses are not an atomic snapshot. Require
            # complete coverage on one recheck, not a union of two short lists.
            previous = records
        if previous is not None:
            for run_id in sorted(previous.keys() - records.keys()):
                record = self.query(
                    "--method", "GET", f"repos/{self.repository}/actions/runs/{run_id}"
                )
                if record["id"] != run_id:
                    raise RuntimeError(
                        "owner recheck returned a different run identity"
                    )
                if record["status"] in ACTIVE_STATUSES:
                    # It may have moved to a status already scanned this pass.
                    records[run_id] = record
                elif record["status"] != "completed":
                    raise RuntimeError(f"owner recheck has unknown status for {run_id}")
        return records

    def owners(self, pulls):
        previous = None
        for _ in range(4):
            runs = {}
            for status in ACTIVE_STATUSES:
                for record in self.status_runs(status).values():
                    if record["path"] in OWNER_PATHS and record["event"] in {
                        "pull_request",
                        "merge_group",
                    }:
                        runs[record["id"]] = record
            owners = self.resolve_owners(pulls, runs)
            identities = {number: sorted(set(ids)) for number, ids in owners.items()}
            if previous == identities:
                return identities
            previous = identities
        raise RuntimeError("selected owner discovery did not stabilize")

    def resolve_owners(self, pulls, runs):
        owners = {number: [] for number in pulls}
        for record in runs.values():
            if record["event"] == "merge_group":
                match = re.search(r"(?:^|/)pr-([1-9][0-9]*)-", record["head_branch"])
                if match is None:
                    raise RuntimeError("merge-group owner has no exact PR identity")
                associated = {int(match[1])}
            else:
                associated = {pull["number"] for pull in record["pull_requests"]}
                if not associated:
                    # Branches are routinely reused. Resolve association through
                    # GitHub rather than guessing ownership from the branch.
                    sha = record["head_sha"]
                    if not re.fullmatch(r"[0-9a-f]{40}", sha):
                        raise RuntimeError("invalid owner commit identity")
                    key = str(record["id"]) + ":" + sha
                    if key not in self.associations:
                        pages = self.query(
                            "--method",
                            "GET",
                            f"repos/{self.repository}/commits/{sha}/pulls",
                            "-f",
                            "per_page=100",
                            "--paginate",
                            "--slurp",
                        )
                        resolved = {pull["number"] for page in pages for pull in page}
                        # Cache only positive association of this exact run and
                        # commit within this sweep. New runs are resolved anew;
                        # missing association is never negative-cached.
                        if resolved:
                            self.associations[key] = sorted(resolved)
                    associated = set(self.associations.get(key, []))
                    matching = [
                        number
                        for number, pull in pulls.items()
                        if pull["state"] != "OPEN"
                        and (
                            record["head_branch"] == pull["headRefName"]
                            or pull["createdAt"]
                            <= record["created_at"]
                            <= pull["closedAt"]
                        )
                        and (
                            record.get("head_repository") is None
                            or record["head_repository"]["full_name"]
                            == (pull["headRepository"] or {}).get("nameWithOwner")
                        )
                    ]
                    for number in matching:
                        pull = pulls[number]
                        # Commit association is not an exclusive historical run
                        # association. A force-pushed old-head run may no longer
                        # appear there. Retain ambiguity when its creation was
                        # within this PR's lifetime; reruns keep the run identity
                        # and original creation time.
                        if number not in associated and (
                            not associated
                            or pull["createdAt"]
                            <= record["created_at"]
                            <= pull["closedAt"]
                        ):
                            raise RuntimeError(
                                f"owner association unresolved for run {record['id']}, PR #{number}"
                            )
            for number in associated & owners.keys():
                owners[number].append(record["id"])
        return owners


class Session:
    """One SSH channel whose remote mutation worker owns the namespace locks."""

    def __init__(self, host, user, numbers):
        self.host = host
        self.numbers = numbers
        self.stopped = threading.Event()
        self.writer = threading.Lock()
        self.write_error = None
        self.response_buffer = b""
        source = base64.b64encode(
            (HERE / "cleanup-metal-resources.py").read_bytes()
        ).decode()
        code = shlex.quote(f'import base64;exec(base64.b64decode("{source}"))')
        self.process = subprocess.Popen(
            [
                "ssh",
                f"{user}@{host}",
                "sudo",
                "python3",
                "-c",
                code,
                "session",
                *map(str, numbers),
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            text=True,
            bufsize=1,
            start_new_session=True,
        )
        CHILDREN.add(self.process.pid)
        try:
            if self.read(70) != {"ready": numbers}:
                raise RuntimeError(f"invalid lock readiness from {host}")
        except BaseException:
            self.abort()
            raise
        self.heartbeat = threading.Thread(target=self.keep_alive, daemon=True)
        self.heartbeat.start()

    def send(self, message):
        with self.writer:
            self.process.stdin.write(json.dumps(message) + "\n")
            self.process.stdin.flush()

    def read(self, timeout):
        # Readability means bytes, not a complete line. A buffered readline
        # could otherwise outlive the deadline on a stalled partial reply.
        deadline = time.monotonic() + timeout
        while b"\n" not in self.response_buffer:
            remaining = deadline - time.monotonic()
            if (
                remaining <= 0
                or not select.select([self.process.stdout], [], [], remaining)[0]
            ):
                raise TimeoutError(f"worker response deadline exceeded on {self.host}")
            chunk = os.read(self.process.stdout.fileno(), 65536)
            if not chunk:
                raise RuntimeError(f"worker channel closed on {self.host}")
            self.response_buffer += chunk
        line, _, self.response_buffer = self.response_buffer.partition(b"\n")
        return json.loads(line)

    def keep_alive(self):
        while not self.stopped.wait(10):
            try:
                self.send({"operation": "heartbeat"})
            except OSError as error:
                self.write_error = error
                return

    def cleanup(self, numbers):
        if self.write_error is not None or self.process.poll() is not None:
            raise RuntimeError(f"namespace lock worker unavailable on {self.host}")
        self.send({"operation": "cleanup", "numbers": numbers})
        result = self.read(150)["results"]
        if set(result) != {str(number) for number in numbers}:
            raise RuntimeError(f"worker omitted namespace results on {self.host}")
        return {int(number): outcome for number, outcome in result.items()}

    def close(self):
        try:
            self.send({"operation": "release"})
            if self.read(5) != {"released": True}:
                raise RuntimeError(f"lock release unconfirmed on {self.host}")
            self.stopped.set()
            self.heartbeat.join(timeout=1)
            try:
                self.process.stdin.close()
            except OSError:
                # Release was acknowledged; abort below retires the channel.
                pass
            if self.process.wait(timeout=5):
                raise RuntimeError(f"lock worker failed during release on {self.host}")
        finally:
            self.abort()

    def abort(self):
        self.stopped.set()
        heartbeat = getattr(self, "heartbeat", None)
        if heartbeat is not None:
            heartbeat.join(timeout=1)
        if self.process.poll() is None:
            try:
                os.killpg(self.process.pid, signal.SIGTERM)
            except ProcessLookupError:
                # It exited between poll and kill; wait below still reaps it.
                pass
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(self.process.pid, signal.SIGKILL)
                self.process.wait()
        for stream in (self.process.stdin, self.process.stdout):
            try:
                stream.close()
            except OSError:
                # The worker is reaped; preserve the original channel failure.
                pass
        CHILDREN.discard(self.process.pid)


def remote(host, user, operation, numbers):
    # Only validated host/user, operation and positive integers enter SSH's
    # command argument. The trusted executor is streamed over stdin, not staged
    # into a mutable PR-owned directory on the host.
    output = run(
        [
            "ssh",
            f"{user}@{host}",
            "sudo",
            "python3",
            "-",
            operation,
            *map(str, numbers),
        ],
        input=(HERE / "cleanup-metal-resources.py").read_text(),
        timeout=180,
    )
    result = json.loads(output)
    if not isinstance(result, dict) or any(
        not key.isdigit() or int(key) <= 0 for key in result
    ):
        raise RuntimeError("invalid remote resource result")
    return {int(key): value for key, value in result.items()}


def observe_hosts(hosts, user, operation, numbers):
    results = {}
    with ThreadPoolExecutor(max_workers=min(len(hosts), 2)) as pool:
        futures = {
            host: pool.submit(remote, host, user, operation, numbers) for host in hosts
        }
        for host, future in futures.items():
            try:
                results[host] = future.result()
            except (
                OSError,
                ValueError,
                RuntimeError,
                subprocess.SubprocessError,
            ) as error:
                print(
                    f"::error::Metal {operation} unverified on {host}: {error}",
                    file=sys.stderr,
                )
                results[host] = None
    return results


def reconcile_batch(github, hosts, user, numbers):
    sessions = {}
    decisions = {}
    errors = []
    started = time.monotonic()
    pages_before = github.requests
    try:
        # Lock all selected namespaces on every configured host before asking
        # for fresh authority. The mutation worker itself retains each flock.
        for host in hosts:
            sessions[host] = Session(host, user, numbers)
        locked = time.monotonic()
        pulls = github.pulls(numbers)
        state_finished = time.monotonic()
        owners = github.owners(pulls)
        owners_finished = time.monotonic()
        # Owner discovery may take several API pages. A scheduled sweep is not
        # cancelled by a reopen event, so refresh PR state at the mutation
        # boundary instead of authorizing from the earlier CLOSED snapshot.
        pulls = github.pulls(numbers)
        authorized = time.monotonic()
        selected = []
        for number in numbers:
            if pulls[number]["state"] == "OPEN":
                decisions[number] = {"outcome": "skipped_open"}
            elif owners[number]:
                decisions[number] = {
                    "outcome": "deferred_owner",
                    "runs": owners[number],
                }
            else:
                selected.append(number)
        if selected:
            with ThreadPoolExecutor(max_workers=min(len(hosts), 2)) as pool:
                futures = {
                    host: pool.submit(session.cleanup, selected)
                    for host, session in sessions.items()
                }
                for host, future in futures.items():
                    try:
                        result = future.result()
                    except (
                        OSError,
                        ValueError,
                        KeyError,
                        RuntimeError,
                        subprocess.SubprocessError,
                    ) as error:
                        errors.append(f"{host}: {error}")
                        result = {
                            number: {"outcome": "unverified", "error": str(error)}
                            for number in selected
                        }
                    for number in selected:
                        outcome = result[number]
                        if outcome["outcome"] not in {
                            "cleaned",
                            "already_absent",
                            "failed",
                            "unverified",
                        }:
                            raise RuntimeError("invalid cleanup outcome")
                        decisions.setdefault(number, {"hosts": {}})["hosts"][host] = (
                            outcome
                        )
        print(
            json.dumps(
                {
                    "batch": numbers,
                    "lock_seconds": round(locked - started, 3),
                    "pr_state_seconds": round(state_finished - locked, 3),
                    "owner_seconds": round(owners_finished - state_finished, 3),
                    "authorization_seconds": round(authorized - owners_finished, 3),
                    "cleanup_seconds": round(time.monotonic() - authorized, 3),
                    "github_response_pages": github.requests - pages_before,
                }
            ),
            file=sys.stderr,
        )
    except (
        OSError,
        ValueError,
        KeyError,
        RuntimeError,
        subprocess.SubprocessError,
    ) as error:
        errors.append(str(error))
    finally:
        for host, session in reversed(list(sessions.items())):
            try:
                session.close()
            except (
                OSError,
                ValueError,
                KeyError,
                RuntimeError,
                subprocess.SubprocessError,
            ) as error:
                errors.append(f"{host} release: {error}")
    if errors:
        return {
            number: {
                "outcome": "unverified",
                "lifecycle_error": "; ".join(errors),
                "resource_result": decisions.get(number),
            }
            for number in numbers
        }
    return decisions


def summarize(decisions):
    counts = Counter()
    for number, decision in sorted(decisions.items()):
        if "hosts" in decision:
            outcomes = {host["outcome"] for host in decision["hosts"].values()}
            outcome = next(
                status
                for status in ("unverified", "failed", "cleaned", "already_absent")
                if status in outcomes
            )
        else:
            outcome = decision["outcome"]
        counts[outcome] += 1
        print(
            json.dumps(
                {"pr": number, "outcome": outcome, **decision}, separators=(",", ":")
            )
        )
    print("=== Metal Resource Cleanup Summary ===")
    print(json.dumps(dict(counts), sort_keys=True))
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a") as handle:
            handle.write(
                "### Metal resource cleanup\n\n| Outcome | Namespaces |\n| --- | ---: |\n"
            )
            for outcome, count in sorted(counts.items()):
                handle.write(f"| {outcome} | {count} |\n")
    return bool(counts["failed"] or counts["unverified"])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.parse_args()
    for name in (
        "GH_TOKEN",
        "GITHUB_REPOSITORY",
        "GITHUB_RUN_ID",
        "METAL_HOSTS",
        "METAL_USER",
    ):
        if not os.environ.get(name):
            parser.error(f"missing {name}")
    if not os.environ["GITHUB_RUN_ID"].isdigit():
        parser.error("invalid workflow run ID")
    hosts = sorted(
        {host.strip() for host in os.environ["METAL_HOSTS"].split(",") if host.strip()}
    )
    user = os.environ["METAL_USER"]
    if (
        not hosts
        or any(not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9.-]*", host) for host in hosts)
        or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_-]*", user)
    ):
        parser.error("invalid metal host or user")
    github = GitHub(os.environ["GITHUB_REPOSITORY"])
    requested = os.environ.get("RUNNER_PR_NUMBERS", "")
    if requested and any(
        not re.fullmatch(r"[1-9][0-9]*", value.strip())
        for value in requested.split(",")
    ):
        parser.error("RUNNER_PR_NUMBERS must be comma-separated positive PR numbers")
    selection = {int(value) for value in requested.split(",")} if requested else None
    started = time.monotonic()
    inventory = observe_hosts(
        hosts, user, "inventory", sorted(selection) if selection else []
    )
    print(
        f"Metal inventory: {time.monotonic() - started:.2f}s, {len(hosts)} configured hosts",
        file=sys.stderr,
    )
    incomplete = any(value is None for value in inventory.values())
    numbers = sorted(
        {
            number
            for resources in inventory.values()
            if resources is not None
            for number in resources
            if selection is None or number in selection
        }
    )
    pulls = github.pulls(numbers)
    numbers = [number for number in numbers if pulls[number]["state"] != "OPEN"]
    if os.environ.get("DRY_RUN", "false") == "true":
        print(
            json.dumps(
                {
                    "dry_run": True,
                    "candidates": numbers,
                    "incomplete_inventory": incomplete,
                }
            )
        )
        return int(incomplete)
    if incomplete:
        summarize(
            {
                number: {
                    "outcome": "unverified",
                    "error": "all-host inventory incomplete",
                }
                for number in numbers
            }
        )
        return 1
    decisions = {}
    for offset in range(0, len(numbers), BATCH_SIZE):
        batch = numbers[offset : offset + BATCH_SIZE]
        signal.alarm(360)
        try:
            decisions.update(reconcile_batch(github, hosts, user, batch))
        finally:
            signal.alarm(0)
    return int(summarize(decisions) or incomplete)


if __name__ == "__main__":

    def terminate(signum, _frame):
        CANCELLED.set()
        for pid in list(CHILDREN):
            try:
                os.killpg(pid, signal.SIGTERM)
            except ProcessLookupError:
                # A child may exit between the registry snapshot and signal.
                pass
        raise SystemExit(128 + signum)

    def batch_deadline(_signum, _frame):
        for pid in list(CHILDREN):
            try:
                os.killpg(pid, signal.SIGTERM)
            except ProcessLookupError:
                # A child may exit between the registry snapshot and signal.
                pass
        raise TimeoutError("cleanup batch deadline exceeded")

    signal.signal(signal.SIGALRM, batch_deadline)
    signal.signal(signal.SIGINT, terminate)
    signal.signal(signal.SIGTERM, terminate)
    signal.signal(signal.SIGHUP, terminate)
    try:
        sys.exit(main())
    except (
        OSError,
        ValueError,
        KeyError,
        RuntimeError,
        subprocess.SubprocessError,
    ) as error:
        print(f"::error::Metal cleanup unverified: {error}", file=sys.stderr)
        sys.exit(1)
