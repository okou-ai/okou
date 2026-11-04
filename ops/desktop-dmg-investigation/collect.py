#!/usr/bin/env python3
"""Temporary bounded real-tool investigation for #45280; no recovery retries."""

import json
import os
import plistlib
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path


def native_tool():
    directory = Path(os.environ["OKOU_DMG_LOG_DIR"])
    record = Path(tempfile.mkdtemp(prefix=sys.argv[1] + "-", dir=directory))
    command = ["/usr/bin/hdiutil", *sys.argv[1:]]
    start = time.time()
    (record / "started.json").write_text(json.dumps({"command": command, "started": start}))
    with (record / "stdout.txt").open("wb") as stdout, (record / "stderr.txt").open("wb") as stderr:
        result = subprocess.run(command, stdout=stdout, stderr=stderr)
    (record / "operation.json").write_text(json.dumps({
        "command": command, "started": start, "elapsed": time.time() - start,
        "returncode": result.returncode,
    }, indent=2))
    if result.returncode:
        target = next((arg for arg in sys.argv[2:] if arg.endswith(".dmg")), sys.argv[2])
        for name, arguments in (
            ("images.plist", ["/usr/bin/hdiutil", "info", "-plist"]),
            ("processes.txt", ["/bin/ps", "-axo", "pid,ppid,stat,comm"]),
            ("image-handles.txt", ["/usr/sbin/lsof", target]),
            ("imageinfo.plist", ["/usr/bin/hdiutil", "imageinfo", "-plist", target]),
        ):
            try:
                observed = subprocess.run(arguments, capture_output=True, timeout=15)
                (record / name).write_bytes(observed.stdout + observed.stderr)
            except subprocess.TimeoutExpired:
                (record / name).write_text("Diagnostic timed out\n")
    sys.stdout.buffer.write((record / "stdout.txt").read_bytes())
    sys.stderr.buffer.write((record / "stderr.txt").read_bytes())
    sys.exit(result.returncode)


def investigate():
    output = Path(sys.argv[1]).resolve()
    output.mkdir(parents=True)
    wrapper = output / "bin"
    wrapper.mkdir()
    (wrapper / "hdiutil").symlink_to(Path(__file__).resolve())
    environment = dict(os.environ, PATH=f"{wrapper}:{os.environ['PATH']}")
    failures = []
    for index in range(1, 25):
        directory = output / f"suite-{index:02d}"
        directory.mkdir()
        environment["OKOU_DMG_LOG_DIR"] = str(directory)
        started = time.time()
        timed_out = False
        with (directory / "suite.stdout").open("wb") as stdout, (directory / "suite.stderr").open("wb") as stderr:
            process = subprocess.Popen(
                [sys.executable, "desktop/scripts/debug_symbols_test.py", "-v"],
                stdout=stdout, stderr=stderr, env=environment, start_new_session=True,
            )
            try:
                process.wait(timeout=90)
            except subprocess.TimeoutExpired:
                timed_out = True
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()
        summary = {"iteration": index, "started": started, "elapsed": time.time() - started, "returncode": process.returncode, "timed_out": timed_out}
        print(json.dumps(summary), flush=True)
        (directory / "result.json").write_text(json.dumps(summary, indent=2))
        images = subprocess.check_output(["/usr/bin/hdiutil", "info", "-plist"])
        (directory / "after-images.plist").write_bytes(images)
        print("remaining-test-images:", json.dumps([image.get("image-path") for image in plistlib.loads(images).get("images", []) if "okou-" in image.get("image-path", "")]), flush=True)
        for operation in directory.glob("*/operation.json"):
            data = json.loads(operation.read_text())
            print(json.dumps(data), flush=True)
            if data["returncode"]:
                print((operation.parent / "stderr.txt").read_text(), flush=True)
                for diagnostic in ("images.plist", "image-handles.txt"):
                    print(diagnostic, (operation.parent / diagnostic).read_text(), flush=True)
        if process.returncode:
            failures.append(index)
            print((directory / "suite.stdout").read_text(), (directory / "suite.stderr").read_text(), flush=True)
        if timed_out:
            break
    print("Failed independent iterations:", failures, flush=True)
    sys.exit(bool(failures))


if __name__ == "__main__":
    if Path(sys.argv[0]).name == "hdiutil":
        native_tool()
    else:
        investigate()
