"""Read production Runner process/service state and sanitized bundle cache events.

Run `fleet [UTC-since]` through the existing production SSH transport. The `local`
mode runs as root on a host. No Runner commands, configuration or data are changed.
Only version/PID/service metadata and allowlisted cache fields leave the host.

Requires Linux, Python 3.10+, systemd tools, and fleet-mode AWS_METAL_RUNNER_HOSTS /
AWS_METAL_RUNNER_USER with the existing SSH setup. UTC-since defaults to one hour
ago and must be within 24 hours. Stdout is JSON; exit 1 means incomplete evidence.
Local collection has a 90-second deadline; each SSH call has a 120-second bound.
"""

import datetime as dt
import json
import os
import re
import shlex
import signal
import subprocess
import sys
from pathlib import Path

VERSION = r"v[0-9]+\.[0-9]+\.[0-9]+"
UNIT = re.compile(r"vm0-runner-(" + VERSION + r")\.service\Z")
EXECUTABLE = re.compile(r"/var/lib/vm0-runner/bin/(" + VERSION + r")/runner\Z")
PROPERTIES = {
    "Id",
    "LoadState",
    "ActiveState",
    "SubState",
    "UnitFileState",
    "MainPID",
    "ControlPID",
}
MAX_OUTPUT = 4 * 1024 * 1024


def now():
    return dt.datetime.now(dt.timezone.utc)


def require(condition):
    if not condition:
        raise ValueError("invalid inspection boundary")


def since_time(value):
    require(bool(re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ", value)))
    parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    require(now() - dt.timedelta(hours=24) <= parsed <= now() + dt.timedelta(minutes=5))
    return value


def command(args, *, empty_match=False):
    result = subprocess.run(args, capture_output=True, timeout=30, check=False)
    require(
        result.returncode == 0
        or (
            empty_match
            and result.returncode == 1
            and not result.stdout
            and not result.stderr
        )
    )
    require(len(result.stdout) <= MAX_OUTPUT)
    return result.stdout.decode()


def processes(proc):
    entries = list(proc.iterdir())
    require(len(entries) <= 32768)
    found = []
    for entry in entries:
        if not entry.name.isascii() or not entry.name.isdigit():
            continue
        try:
            executable = os.readlink(entry / "exe").removesuffix(" (deleted)")
        except (FileNotFoundError, ProcessLookupError):
            continue
        if Path(executable).name != "runner":
            continue
        match = EXECUTABLE.fullmatch(executable)
        # Unknown Runner owners must not disappear from an exit decision.
        require(match is not None)
        found.append({"pid": int(entry.name), "version": match[1]})
    require(len(found) <= 512)
    return sorted(found, key=lambda item: item["pid"])


def cache_event(record):
    message = record.get("MESSAGE")
    if not isinstance(message, str):
        return None
    message = re.sub(r"\x1b\[[0-9;]*m", "", message)
    if "runner_storage::content_bundle_cache:" not in message:
        return None
    if "content bundle cache lookup" in message:
        kind = "lookup"
    elif "content bundle download attempt" in message:
        kind = "download"
    else:
        return None
    digest = re.search(r'\bsha256="?([a-f0-9]{64})\b', message)
    timestamp = record.get("__REALTIME_TIMESTAMP")
    require(digest is not None and isinstance(timestamp, str) and timestamp.isdigit())
    result = {"event": kind, "sha256": digest[1], "timestampUs": int(timestamp)}
    for field, pattern in (
        ("cache_hit", r"true|false"),
        ("archive_bytes", r"[0-9]+"),
        ("attempt", r"[0-9]+"),
        ("duration_ms", r"[0-9]+"),
        ("success", r"true|false"),
    ):
        match = re.search(r"\b" + field + r"=(" + pattern + r")\b", message)
        if match:
            result[field] = (
                match[1] == "true" if match[1] in {"true", "false"} else int(match[1])
            )
    require(
        "cache_hit" in result
        if kind == "lookup"
        else {"attempt", "success"} <= result.keys()
    )
    return result


def inspect(since):
    started = now().isoformat()
    before = processes(Path("/proc"))
    names = set()
    for args in (
        [
            "systemctl",
            "list-units",
            "vm0-runner-v*.service",
            "--all",
            "--plain",
            "--no-legend",
        ],
        ["systemctl", "list-unit-files", "vm0-runner-v*.service", "--no-legend"],
    ):
        for line in command(args).splitlines():
            if line.split() and UNIT.fullmatch(line.split()[0]):
                names.add(line.split()[0])
    require(len(names) <= 128)
    services = []
    events = []
    for unit in sorted(names):
        values = dict(
            line.split("=", 1)
            for line in command(
                [
                    "systemctl",
                    "show",
                    "--all",
                    "--no-pager",
                    "--property=" + ",".join(sorted(PROPERTIES)),
                    unit,
                ]
            ).splitlines()
        )
        require(set(values) == PROPERTIES and values["Id"] == unit)
        for field in ("MainPID", "ControlPID"):
            require(values[field].isascii() and values[field].isdigit())
            values[field] = int(values[field])
        for field in ("LoadState", "ActiveState", "SubState", "UnitFileState"):
            if field == "UnitFileState" and values[field] == "":
                continue
            require(bool(re.fullmatch(r"[a-z-]{1,32}", values[field])))
        services.append(values)
        if values["ActiveState"] not in {"active", "deactivating"}:
            continue
        output = command(
            [
                "journalctl",
                "--quiet",
                "--no-pager",
                "-u",
                unit,
                "--since",
                since,
                "-o",
                "json",
                "--output-fields=__REALTIME_TIMESTAMP,MESSAGE",
                "--grep=content bundle (cache lookup|download attempt)",
                "-n",
                "2000",
            ],
            empty_match=True,
        )
        lines = output.splitlines()
        require(len(lines) < 2000)
        for line in lines:
            event = cache_event(json.loads(line))
            if event is not None:
                events.append({"version": UNIT.fullmatch(unit)[1], **event})
    after = processes(Path("/proc"))
    return {
        "startedAt": started,
        "finishedAt": now().isoformat(),
        "since": since,
        "collectionComplete": before == after,
        "processes": after,
        "services": services,
        "cacheEvents": events,
    }


def fleet(since):
    hosts = os.environ["AWS_METAL_RUNNER_HOSTS"].split(",")
    user = os.environ["AWS_METAL_RUNNER_USER"]
    require(0 < len(hosts) <= 32 and len(set(hosts)) == len(hosts))
    require(
        all(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9.-]*\.vm3\.ai", host) for host in hosts)
    )
    require(bool(re.fullmatch(r"[a-z_][a-z0-9_-]{0,31}", user)))
    script = Path(__file__).read_text()
    results = []
    for ordinal, host in enumerate(hosts, 1):
        try:
            result = subprocess.run(
                [
                    "ssh",
                    "-T",
                    "-o",
                    "BatchMode=yes",
                    user + "@" + host,
                    shlex.join(["sudo", "-n", "python3", "-", "local", since]),
                ],
                input=script,
                capture_output=True,
                text=True,
                timeout=120,
                check=True,
            )
            require(len(result.stdout) <= MAX_OUTPUT)
            report = json.loads(result.stdout)
            validate_report(report)
            results.append({"hostOrdinal": ordinal, **report})
        except (OSError, ValueError, subprocess.SubprocessError):
            results.append(
                {
                    "hostOrdinal": ordinal,
                    "collectionComplete": False,
                    "error": "host inspection unavailable",
                }
            )
    return {
        "hostsExpected": len(hosts),
        "hosts": results,
        "collectionComplete": all(item["collectionComplete"] for item in results),
    }


def validate_report(report):
    require(
        isinstance(report, dict)
        and set(report)
        == {
            "startedAt",
            "finishedAt",
            "since",
            "collectionComplete",
            "processes",
            "services",
            "cacheEvents",
        }
    )
    require(type(report["collectionComplete"]) is bool)
    for field in ("startedAt", "finishedAt", "since"):
        require(isinstance(report[field], str) and len(report[field]) <= 40)
        dt.datetime.fromisoformat(report[field].replace("Z", "+00:00"))
    require(isinstance(report["processes"], list) and len(report["processes"]) <= 512)
    for process in report["processes"]:
        require(isinstance(process, dict) and set(process) == {"pid", "version"})
        require(type(process["pid"]) is int and 0 < process["pid"] < 2**31)
        require(
            isinstance(process["version"], str)
            and re.fullmatch(VERSION, process["version"])
        )
    require(isinstance(report["services"], list) and len(report["services"]) <= 128)
    for service in report["services"]:
        require(isinstance(service, dict) and set(service) == PROPERTIES)
        require(isinstance(service["Id"], str) and UNIT.fullmatch(service["Id"]))
        for field in ("MainPID", "ControlPID"):
            require(type(service[field]) is int and 0 <= service[field] < 2**31)
        for field in ("LoadState", "ActiveState", "SubState", "UnitFileState"):
            if field == "UnitFileState" and service[field] == "":
                continue
            require(
                isinstance(service[field], str)
                and re.fullmatch(r"[a-z-]{1,32}", service[field])
            )
    require(
        isinstance(report["cacheEvents"], list) and len(report["cacheEvents"]) <= 256000
    )
    for event in report["cacheEvents"]:
        require(
            isinstance(event, dict)
            and {"version", "event", "sha256", "timestampUs"} <= event.keys()
        )
        require(
            event.keys()
            <= {
                "version",
                "event",
                "sha256",
                "timestampUs",
                "cache_hit",
                "archive_bytes",
                "attempt",
                "duration_ms",
                "success",
            }
        )
        require(
            isinstance(event["version"], str)
            and re.fullmatch(VERSION, event["version"])
        )
        require(event["event"] in {"lookup", "download"})
        require(
            isinstance(event["sha256"], str)
            and re.fullmatch(r"[a-f0-9]{64}", event["sha256"])
        )
        for field, value in event.items():
            if field in {"timestampUs", "archive_bytes", "attempt", "duration_ms"}:
                require(type(value) is int and 0 <= value < 2**63)
            elif field in {"cache_hit", "success"}:
                require(type(value) is bool)
        require(
            "cache_hit" in event
            if event["event"] == "lookup"
            else {"attempt", "success"} <= event.keys()
        )


def main():
    require(2 <= len(sys.argv) <= 3 and sys.argv[1] in {"local", "fleet"})
    since = since_time(
        sys.argv[2]
        if len(sys.argv) == 3
        else (now() - dt.timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
    )
    if sys.argv[1] == "local":
        signal.signal(signal.SIGALRM, deadline)
        signal.alarm(90)
    try:
        report = inspect(since) if sys.argv[1] == "local" else fleet(since)
    finally:
        signal.alarm(0)
    print(json.dumps(report))
    return 0 if report["collectionComplete"] else 1


def deadline(_signum, _frame):
    raise TimeoutError("host inspection deadline")


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (KeyError, OSError, ValueError, subprocess.SubprocessError):
        print(
            json.dumps({"collectionComplete": False, "error": "inspection unavailable"})
        )
        sys.exit(1)
