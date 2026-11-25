"""Reload the managed Caddyfile and verify adoption by the same process."""

import hashlib
import json
import subprocess
import sys
import time
from pathlib import Path


def output(*args):
    return subprocess.check_output(args, text=True, timeout=5)


def service_status(unit):
    return dict(
        line.split("=", 1)
        for line in output(
            "systemctl",
            "show",
            unit,
            "-p",
            "ActiveState",
            "-p",
            "InvocationID",
            "-p",
            "MainPID",
        ).splitlines()
    )


def reload_caddy(unit, config, digest, expected_invocation):
    def verify_config():
        if hashlib.sha256(Path(config).read_bytes()).hexdigest() != digest:
            raise RuntimeError("Caddyfile changed during provisioning")

    status = service_status(unit)
    invocation, pid = status["InvocationID"], status["MainPID"]
    if status["ActiveState"] != "active" or int(pid) <= 0:
        raise RuntimeError("Caddy is not active")
    if invocation != expected_invocation:
        raise RuntimeError("Caddy invocation changed before reload")
    journal = (
        "journalctl",
        "--quiet",
        "--no-pager",
        "--output=json",
        f"_SYSTEMD_INVOCATION_ID={invocation}",
        f"_PID={pid}",
    )
    entries = output(*journal, "-n", "1").splitlines()
    if not entries:
        raise RuntimeError("No journal cursor for the current Caddy process")
    cursor = json.loads(entries[-1])["__CURSOR"]
    verify_config()
    output("systemctl", "kill", "--kill-who=main", "--signal=SIGUSR1", unit)

    # Signal delivery is asynchronous. Record success only after Caddy reports
    # that it loaded the managed source, and only for this PID and invocation.
    deadline = time.monotonic() + 15
    acknowledged = False
    while time.monotonic() < deadline:
        for line in output(*journal, f"--after-cursor={cursor}").splitlines():
            entry = json.loads(line)
            cursor = entry["__CURSOR"]
            try:
                event = json.loads(entry.get("MESSAGE", ""))
            except (TypeError, ValueError):
                continue
            if (
                not isinstance(event, dict)
                or event.get("signal") != "SIGUSR1"
                or event.get("file") != config
            ):
                continue
            if event.get("msg") == "failed to reload config from file":
                raise RuntimeError(f"Caddy rejected the reload: {event.get('error')}")
            if event.get("msg") == "successfully reloaded config from file":
                acknowledged = True
        if acknowledged:
            status = service_status(unit)
            if (status["InvocationID"], status["MainPID"]) != (invocation, pid):
                raise RuntimeError("Caddy invocation or PID changed during reload")
            # journald may observe Caddy's acknowledgement before systemd
            # processes READY=1 from the notification socket.
            if status["ActiveState"] == "active":
                verify_config()
                print(f"Caddyfile reloaded in Caddy PID {pid}, invocation {invocation}")
                return
        time.sleep(0.2)
    raise RuntimeError(
        "Timed out waiting for the current Caddy process to acknowledge reload"
    )


if __name__ == "__main__":
    try:
        reload_caddy(*sys.argv[1:])
    except (
        OSError,
        ValueError,
        KeyError,
        RuntimeError,
        subprocess.SubprocessError,
    ) as error:
        sys.exit(str(error))
