#!/usr/bin/env python3
"""Temporary bounded real-tool investigation for #45280; no recovery retries."""

import json
import os
import plistlib
import subprocess
import sys
import tempfile
import time
from pathlib import Path


def native_tool():
    directory = Path(os.environ["OKOU_DMG_LOG_DIR"])
    record = Path(tempfile.mkdtemp(prefix=sys.argv[1] + "-", dir=directory))
    command = ["/usr/bin/hdiutil", sys.argv[1], "-debug", *sys.argv[2:]]
    start = time.time()
    result = subprocess.run(command, capture_output=True)
    (record / "stdout.txt").write_bytes(result.stdout)
    (record / "stderr.txt").write_bytes(result.stderr)
    (record / "operation.json").write_text(json.dumps({
        "command": command, "started": start, "elapsed": time.time() - start,
        "returncode": result.returncode,
    }, indent=2))
    if result.returncode:
        for name, arguments in (
            ("images.plist", ["/usr/bin/hdiutil", "info", "-plist"]),
            ("processes.txt", ["/bin/ps", "-axo", "pid,ppid,stat,comm"]),
            ("image-handles.txt", ["/usr/sbin/lsof", *[arg for arg in sys.argv[2:] if arg.endswith(".dmg")]]),
        ):
            observed = subprocess.run(arguments, capture_output=True, timeout=15)
            (record / name).write_bytes(observed.stdout + observed.stderr)
    sys.stdout.buffer.write(result.stdout)
    sys.stderr.buffer.write(result.stderr)
    sys.exit(result.returncode)


def investigate():
    output = Path(sys.argv[1]).resolve()
    output.mkdir(parents=True)
    wrapper = output / "bin"
    wrapper.mkdir()
    (wrapper / "hdiutil").symlink_to(Path(__file__).resolve())
    environment = dict(os.environ, PATH=f"{wrapper}:{os.environ['PATH']}")
    failures = []
    for index in range(1, 13):
        directory = output / f"suite-{index:02d}"
        directory.mkdir()
        environment["OKOU_DMG_LOG_DIR"] = str(directory)
        started = time.time()
        result = subprocess.run(
            [sys.executable, "desktop/scripts/debug_symbols_test.py", "-v"],
            capture_output=True, env=environment,
        )
        (directory / "suite.stdout").write_bytes(result.stdout)
        (directory / "suite.stderr").write_bytes(result.stderr)
        summary = {"iteration": index, "started": started, "elapsed": time.time() - started, "returncode": result.returncode}
        print(json.dumps(summary), flush=True)
        (directory / "result.json").write_text(json.dumps(summary, indent=2))
        images = subprocess.check_output(["/usr/bin/hdiutil", "info", "-plist"])
        (directory / "after-images.plist").write_bytes(images)
        print("remaining-images:", json.dumps([image.get("image-path") for image in plistlib.loads(images).get("images", [])]), flush=True)
        for operation in directory.glob("*/operation.json"):
            data = json.loads(operation.read_text())
            print(json.dumps(data), flush=True)
            if data["returncode"]:
                print((operation.parent / "stderr.txt").read_text(), flush=True)
                for diagnostic in ("images.plist", "image-handles.txt"):
                    print(diagnostic, (operation.parent / diagnostic).read_text(), flush=True)
        if result.returncode:
            failures.append(index)
            print(result.stdout.decode(errors="replace"), result.stderr.decode(errors="replace"), flush=True)
    print("Failed independent iterations:", failures, flush=True)
    sys.exit(bool(failures))


if __name__ == "__main__":
    if Path(sys.argv[0]).name == "hdiutil":
        native_tool()
    else:
        investigate()
