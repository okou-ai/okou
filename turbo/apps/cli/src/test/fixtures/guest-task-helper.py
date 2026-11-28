"""External native-launcher fixture; never substitutes for kernel cgroup tests."""

import json
import os
import pathlib
import select
import signal
import sys
import uuid
from contextlib import contextmanager, suppress


@contextmanager
def open_pidfd(pid):
    fd = None
    if pid is not None:
        with suppress(ProcessLookupError):
            fd = os.pidfd_open(pid)
    try:
        yield fd
    finally:
        if fd is not None:
            os.close(fd)


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
    with open_pidfd(tool_pid) as tool_fd, open_pidfd(task["pid"]) as runtime_fd:
        if runtime_fd is not None:
            signal.pidfd_send_signal(runtime_fd, signal.SIGTERM)
            if not select.select([runtime_fd], [], [], 0.1)[0]:
                signal.pidfd_send_signal(runtime_fd, signal.SIGKILL)
            assert select.select([runtime_fd], [], [], 10)[0], "fixture runtime did not exit"
        if tool_fd is not None:
            with suppress(ProcessLookupError):
                signal.pidfd_send_signal(tool_fd, signal.SIGKILL)
            # The stop reply certifies exit. Sending SIGKILL alone only starts it.
            assert select.select([tool_fd], [], [], 10)[0], "fixture tool did not exit"
    stopped = root / (args[1] + ".stopped")
    if tool_pid is None:
        stopped.touch()
    else:
        assert output.is_file(), "fixture registry was removed before the tool stopped"
        stopped.write_text(f"{tool_pid}\n")
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
