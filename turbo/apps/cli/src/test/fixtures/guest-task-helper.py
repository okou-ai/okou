"""External native-launcher fixture; never substitutes for kernel cgroup tests."""

import json
import os
import pathlib
import select
import signal
import sys
import uuid

mode, root_arg, *args = sys.argv[1:]
root = pathlib.Path(root_arg)
root.mkdir(exist_ok=True)

if args[0] == "stop":
    if mode == "stop-failure":
        sys.exit(125)
    record = root / args[1]
    task = json.loads(record.read_text())
    # Capture the fixture's explicitly published tool before the Pi runtime
    # removes its disposable registry. No process-tree discovery is performed.
    tool_pid = None
    output = pathlib.Path(task["directory"]) / "stdout"
    if output.exists():
        try:
            tool_pid = json.loads(output.read_text()).get("toolPid")
        except json.JSONDecodeError:
            # Real Pi stdout is an event stream, not this fixture's optional tool record.
            pass
    try:
        pidfd = os.pidfd_open(task["pid"])
    except ProcessLookupError:
        pidfd = None
    if pidfd is not None:
        signal.pidfd_send_signal(pidfd, signal.SIGTERM)
        if not select.select([pidfd], [], [], 0.1)[0]:
            signal.pidfd_send_signal(pidfd, signal.SIGKILL)
        assert select.select([pidfd], [], [], 10)[0], "fixture runtime did not exit"
        os.close(pidfd)
    if tool_pid:
        try:
            os.killpg(tool_pid, signal.SIGKILL)
        except ProcessLookupError:
            # Runtime cancellation may already have collected the published fixture tool.
            pass
    (root / (args[1] + ".stopped")).touch()
else:
    assert args[:3] == ["--report-fd", "3", "--"]
    program, *target = args[3:]
    directory = pathlib.Path(target[-1])
    task = {"handle": str(uuid.uuid4()), "pid": os.getpid()}
    (root / task["handle"]).write_text(json.dumps({**task, "directory": str(directory), "program": program, "target": target}))
    if mode == "publication-failure":
        (directory / "task").mkdir()
    report = {**task}
    if mode == "wrong-pid":
        report["pid"] += 1
    if mode == "invalid-handle":
        report["handle"] = "../runtime"
    if mode == "missing-report":
        payload = b""
    elif mode == "oversized-report":
        payload = b" " * 4097
    else:
        payload = (json.dumps(report) + "\n").encode()
    os.write(3, payload)
    os.close(3)
    if mode in ("normal", "publication-failure", "stop-failure"):
        os.execvpe(program, [program, *target], os.environ)
    # Await adapter rollback without executing the requested target.
    signal.pause()
