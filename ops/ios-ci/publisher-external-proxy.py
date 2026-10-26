#!/usr/bin/env python3
"""Forward real replay traffic while fencing all R2 keys to one experiment."""

import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time


service = Path(sys.argv[0]).name
args = sys.argv[1:]
prefix = os.environ["PUBLISHER_REPLAY_PREFIX"]
if not re.fullmatch(
    r"okou-ios/experiments/publisher-provenance/[1-9][0-9]*/[1-9][0-9]*/[1-3]-[AB][12]/",
    prefix,
):
    raise ValueError("Refusing a non-experimental storage namespace")
entry = {"service": service}
if service == "aws":
    allowed = json.loads(Path(os.environ["PUBLISHER_REPLAY_KEYS"]).read_text())
    if args[:1] != ["s3api"] or args[1] not in ("get-object", "put-object"):
        raise ValueError("Only replay object reads/writes are allowed")
    position = args.index("--key") + 1
    key = args[position]
    if key not in allowed:
        raise ValueError("Object is outside the exact replay artifact set")
    args[position] = prefix + key
    entry.update(operation=args[1], key=args[position])
    executable = os.environ["PUBLISHER_REAL_AWS"]
elif service == "gh":
    route = os.environ["PUBLISHER_REPLAY_ROUTE"]
    if args[:1] != ["api"] or args[1] not in (
        route,
        f"{route}/jobs?per_page=100",
    ):
        raise ValueError("Only the exact historical builder may be queried")
    entry.update(operation="api", route=args[1])
    executable = os.environ["PUBLISHER_REAL_GH"]
else:
    raise ValueError("Expected an aws or gh proxy executable")
started = time.monotonic()
result = subprocess.run([executable, *args], capture_output=True, check=False)
entry.update(seconds=time.monotonic() - started, exit_code=result.returncode)
with Path(os.environ["PUBLISHER_REPLAY_LOG"]).open("a") as output:
    output.write(json.dumps(entry) + "\n")
sys.stdout.buffer.write(result.stdout)
sys.stderr.buffer.write(result.stderr)
raise SystemExit(result.returncode)
