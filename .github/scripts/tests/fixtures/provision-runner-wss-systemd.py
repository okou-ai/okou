"""Exercise the installed policy with real systemd and delegated CPU cgroups.

Only uniquely named test units are loaded. Each service sees private /run and
account fixtures; no host group, shared Runner policy or live socket is changed.
"""

import grp
import json
import os
import shlex
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path

PREPARATION_UNIT = "okou-runner-wss-host-prepare.service"
HELPER_PATH = "/usr/local/libexec/okou-runner-wss-host-prepare.py"
GROUP = "okou-wss-caddy"


def command(*arguments):
    return subprocess.run(
        arguments, text=True, capture_output=True, check=False, timeout=20
    )


def require_success(result):
    if result.returncode:
        raise AssertionError(f"{result.args}: {result.stdout}\n{result.stderr}")
    return result.stdout.strip()


def property_value(unit, name):
    return require_success(
        command("systemctl", "show", unit, f"--property={name}", "--value")
    )


def snapshot(path):
    metadata = path.lstat()
    return (
        metadata.st_dev,
        metadata.st_ino,
        metadata.st_uid,
        metadata.st_gid,
        stat.S_IMODE(metadata.st_mode),
        metadata.st_mtime_ns,
        metadata.st_ctime_ns,
    )


def probe(result_path):
    # Observe the kernel layout from the actual service process, not a mocked
    # systemctl or a syntax-only unit parser. This is the existing Runner's
    # direct-subgroup contract and production delegation configuration.
    membership = next(
        line.removeprefix("0::")
        for line in Path("/proc/self/cgroup").read_text().splitlines()
        if line.startswith("0::")
    )
    control = Path("/sys/fs/cgroup") / membership.lstrip("/")
    assert control.name == "control", control
    root = control.parent
    children = {path.name for path in root.iterdir() if path.is_dir()}
    assert children <= {"control", "guests"}, children
    assert os.getxattr(root, "user.delegate") == b"1"
    assert not (root / "cgroup.procs").read_text().strip()
    assert "cpu" in (root / "cgroup.controllers").read_text().split()
    # As in HostCpuCgroupManager::initialize_at, the consumer enables the
    # delegated controller; systemd need only make it available and writable.
    (root / "cgroup.subtree_control").write_text("+cpu")
    assert "cpu" in (root / "cgroup.subtree_control").read_text().split()
    guests = root / "guests"
    guests.mkdir(exist_ok=True)
    assert not (guests / "cgroup.procs").read_text().strip()
    (control / "cpu.weight").write_text("36")
    (guests / "cpu.weight").write_text("9964")
    (guests / "cgroup.subtree_control").write_text("+cpu")
    assert "cpu" in (guests / "cgroup.subtree_control").read_text().split()
    children = sorted(path.name for path in root.iterdir() if path.is_dir())
    assert children == ["control", "guests"], children

    namespace = Path("/run/okou-ws").lstat()
    assert stat.S_ISDIR(namespace.st_mode)
    assert namespace.st_uid == 0 and namespace.st_gid == grp.getgrnam(GROUP).gr_gid
    assert stat.S_IMODE(namespace.st_mode) == 0o710
    temporary = result_path.with_suffix(".pending")
    temporary.write_text(
        json.dumps({"pid": os.getpid(), "cgroup": str(root), "children": children})
    )
    temporary.replace(result_path)
    # Keep the successful service active until its test owner stops it.
    signal.pause()


def wait_for_probe(unit, result_path):
    deadline = time.monotonic() + 10
    while not result_path.exists():
        state = property_value(unit, "ActiveState")
        if state not in ("activating", "active") or time.monotonic() >= deadline:
            raise AssertionError(f"{unit} did not pass delegated startup: {state}")
        time.sleep(0.05)
    result = json.loads(result_path.read_text())
    assert int(property_value(unit, "MainPID")) == result["pid"], result
    assert property_value(unit, "ActiveState") == "active"
    return result


def test_policy(repo):
    assert os.geteuid() == 0, "real systemd fixtures require root"
    require_success(command("systemctl", "show", "--property=Version", "--value"))
    token = uuid.uuid4().hex
    host_unit = f"okou-wss-host-test-{token}.service"
    runner_units = [
        f"vm0-runner-wss-host-test-{token}-{index}.service" for index in range(9)
    ]
    transient_unit = f"vm0-runner-wss-host-test-{token}-transient.service"
    unit_root = Path("/run/systemd/system")
    for unit in [host_unit, *runner_units, transient_unit]:
        assert not (unit_root / unit).exists()
        assert not (unit_root / f"{unit}.d").exists()
        assert property_value(unit, "LoadState") == "not-found"
    paths = []
    owned_units = []
    listener = client = peer = None
    workspace = tempfile.TemporaryDirectory(prefix="okou-wss-systemd-")
    try:
        work = Path(workspace.name)
        runtime = work / "run"
        runtime.mkdir(mode=0o755)
        groups = work / "group"
        groups.write_text(f"root:x:0:\n{GROUP}:x:999:\n")
        nsswitch = work / "nsswitch.conf"
        nsswitch.write_text("passwd: files\ngroup: files\nshadow: files\n")
        namespace = runtime / "okou-ws"
        context = (
            "\n[Service]\n"
            f"BindPaths={shlex.quote(str(runtime))}:/run\n"
            f"BindReadOnlyPaths={shlex.quote(str(groups))}:/etc/group "
            f"{shlex.quote(str(nsswitch))}:/etc/nsswitch.conf\n"
            "PrivateNetwork=yes\nTimeoutStartSec=10\nTimeoutStopSec=5\n"
        )

        preparation = (repo / "ansible/files" / PREPARATION_UNIT).read_text()
        preparation = preparation.replace(
            HELPER_PATH,
            shlex.quote(str(repo / "ansible/files/okou-runner-wss-host-prepare.py")),
        )
        host_path = unit_root / host_unit
        with host_path.open("x") as stream:
            stream.write(preparation + context)
        paths.append(host_path)
        owned_units.append(host_unit)

        # Instance-specific copies isolate this policy from every real
        # release/preview service; the native fixture separately checks
        # resolution of the unchanged production prefix drop-in filename.
        policy = (repo / "ansible/files/okou-runner-wss-host.conf").read_text()
        policy = policy.replace(PREPARATION_UNIT, host_unit)
        for index, unit in enumerate(runner_units):
            unit_path = unit_root / unit
            result_path = work / f"probe-{index}.json"
            with unit_path.open("x") as stream:
                stream.write(
                    "[Service]\nType=simple\n"
                    f"ExecStart=/usr/bin/python3 {shlex.quote(str(Path(__file__).resolve()))} "
                    f"--probe {shlex.quote(str(result_path))}\n"
                    "Delegate=cpu\nDelegateSubgroup=control\nRuntimeMaxSec=60\n"
                    + context
                )
            paths.append(unit_path)
            owned_units.append(unit)
            drop_in = unit_root / f"{unit}.d"
            drop_in.mkdir()
            paths.append(drop_in)
            policy_path = drop_in / "10-wss-host.conf"
            with policy_path.open("x") as stream:
                stream.write(policy)
            paths.append(policy_path)

        transient_drop_in = unit_root / f"{transient_unit}.d"
        transient_drop_in.mkdir()
        paths.append(transient_drop_in)
        transient_policy = transient_drop_in / "10-wss-host.conf"
        with transient_policy.open("x") as stream:
            stream.write(policy)
        paths.append(transient_policy)

        require_success(command("systemctl", "daemon-reload"))
        assert property_value(host_unit, "StartLimitIntervalUSec") == "0"
        assert property_value(host_unit, "RemainAfterExit") == "no"

        # A missing namespace is restored before the real delegated main
        # process. The finished oneshot must not stop its requiring Runner.
        assert not namespace.exists()
        first = runner_units[0]
        require_success(command("systemctl", "start", first))
        results = [wait_for_probe(first, work / "probe-0.json")]
        assert property_value(host_unit, "ActiveState") == "inactive"

        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        endpoint = namespace / "live.sock"
        listener.bind(str(endpoint))
        listener.listen(1)
        os.chown(endpoint, 0, 999)
        endpoint.chmod(0o660)
        client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        client.connect(str(endpoint))
        peer, _ = listener.accept()
        namespace_before = snapshot(namespace)
        endpoint_before = snapshot(endpoint)

        # A burst shares one preparation unit, not one extra host-global
        # start-rate quota. No elapsed-time assertion makes this flaky.
        for index, unit in enumerate(runner_units[1:8], start=1):
            require_success(command("systemctl", "start", unit))
            results.append(wait_for_probe(unit, work / f"probe-{index}.json"))
            assert snapshot(namespace) == namespace_before
            assert snapshot(endpoint) == endpoint_before
            if index == 1:
                assert int(property_value(first, "MainPID")) == results[0]["pid"]
                assert property_value(first, "ActiveState") == "active"
            require_success(command("systemctl", "stop", unit))

        client.sendall(b"still connected")
        assert peer.recv(64) == b"still connected"
        assert property_value(host_unit, "ActiveState") == "inactive"

        # Failed preparation is fatal before the dependent main executes,
        # leaves the live endpoint untouched, and can recover on a retry.
        namespace.chmod(0o755)
        invalid_before = snapshot(namespace)
        invalid_unit = runner_units[8]
        failed = command("systemctl", "start", invalid_unit)
        assert failed.returncode != 0, failed
        assert not (work / "probe-8.json").exists()
        assert property_value(host_unit, "Result") == "exit-code"
        assert snapshot(namespace) == invalid_before
        assert snapshot(endpoint) == endpoint_before
        assert int(property_value(first, "MainPID")) == results[0]["pid"]
        assert property_value(first, "ActiveState") == "active"
        namespace.chmod(0o710)
        require_success(command("systemctl", "start", invalid_unit))
        results.append(wait_for_probe(invalid_unit, work / "probe-8.json"))
        require_success(command("systemctl", "stop", invalid_unit))
        assert int(property_value(first, "MainPID")) == results[0]["pid"]
        assert property_value(first, "ActiveState") == "active"
        require_success(command("systemctl", "stop", first))
        client.sendall(b"still connected after recovery")
        assert peer.recv(64) == b"still connected after recovery"
        peer.close()
        client.close()
        listener.close()
        peer = client = listener = None

        # Only test-owned fixtures are removed to simulate lost volatile
        # state; a later start must not trust a stale successful oneshot.
        endpoint.unlink()
        namespace.rmdir()
        (work / "probe-0.json").unlink()
        require_success(command("systemctl", "start", first))
        results.append(wait_for_probe(first, work / "probe-0.json"))
        require_success(command("systemctl", "stop", first))
        assert property_value(host_unit, "ActiveState") == "inactive"

        # Preview/behavior consumers use Runner's transient Type=exec path.
        # An absent namespace proves the drop-in dependencies are honored by
        # systemd-run too, rather than relying on earlier static-unit setup.
        namespace.rmdir()
        transient_result = work / "probe-transient.json"
        owned_units.append(transient_unit)
        require_success(
            command(
                "systemd-run",
                f"--unit={transient_unit}",
                "--expand-environment=no",
                "--property=Type=exec",
                "--property=Restart=on-failure",
                "--property=RestartSec=5",
                "--property=Delegate=cpu",
                "--property=DelegateSubgroup=control",
                "--property=RuntimeMaxSec=60",
                "--property=TimeoutStopSec=5",
                f"--property=BindPaths={runtime}:/run",
                f"--property=BindReadOnlyPaths={groups}:/etc/group "
                f"{nsswitch}:/etc/nsswitch.conf",
                "--property=PrivateNetwork=yes",
                "/usr/bin/python3",
                str(Path(__file__).resolve()),
                "--probe",
                str(transient_result),
            )
        )
        transient_start = wait_for_probe(transient_unit, transient_result)
        results.append(transient_start)
        assert property_value(host_unit, "ActiveState") == "inactive"

        # Automatic Restart=on-failure must also re-run inactive prerequisites,
        # not only explicit systemctl starts. Kill only this owned test process.
        namespace.rmdir()
        transient_result.unlink()
        require_success(
            command(
                "systemctl",
                "kill",
                "--kill-who=main",
                "--signal=SIGKILL",
                transient_unit,
            )
        )
        restarted = wait_for_probe(transient_unit, transient_result)
        assert restarted["pid"] != transient_start["pid"]
        results.append(restarted)
        assert property_value(host_unit, "ActiveState") == "inactive"
        require_success(command("systemctl", "stop", transient_unit))
        print(json.dumps({"delegated_startups": results, "failure_gate": "passed"}))
    except BaseException:
        diagnostics = command(
            "journalctl",
            "--no-pager",
            "-n",
            "80",
            f"--unit={host_unit}",
            *(f"--unit={unit}" for unit in [*runner_units, transient_unit]),
        )
        print(diagnostics.stdout, file=sys.stderr)
        raise
    finally:
        # Quiesce every owned service before removing its unit or data files.
        for unit in owned_units:
            command("systemctl", "stop", unit)
            assert property_value(unit, "ActiveState") not in (
                "active",
                "activating",
                "deactivating",
                "reloading",
            )
            command("systemctl", "reset-failed", unit)
        for connection in (peer, client, listener):
            if connection is not None:
                connection.close()
        for path in reversed(paths):
            if path.is_dir():
                path.rmdir()
            else:
                path.unlink()
        require_success(command("systemctl", "daemon-reload"))
        workspace.cleanup()


def terminate_test(_signal, _frame):
    # Cancellation still runs the owner's service/file cleanup in finally.
    raise SystemExit(143)


if __name__ == "__main__":
    if sys.argv[1] == "--probe":
        probe(Path(sys.argv[2]))
    else:
        signal.signal(signal.SIGTERM, terminate_test)
        test_policy(Path(sys.argv[1]).resolve())
