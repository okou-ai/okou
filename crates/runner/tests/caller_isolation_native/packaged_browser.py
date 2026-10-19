"""Read a synthetic local page with the real packaged browser toolchain."""

import hashlib
import json
import struct
from pathlib import Path

import packaged_audit


def probe(env, as_role, record):
    script = """set -euo pipefail
session=okou-native-owned
trap 'agent-browser --session "$session" close >/dev/null 2>&1 || true' EXIT
python3 -c 'import json,os,pathlib; print(json.dumps({"uid":os.getuid(),"context":pathlib.Path("/proc/self/attr/current").read_text().rstrip("\\0")}))'
agent-browser --session "$session" open 'data:text/html,%3Cmain%20id%3D%22native-marker%22%3EOWNED_BROWSER_DOM%3C%2Fmain%3E'
marker=$(agent-browser --session "$session" get text '#native-marker')
test "$marker" = OWNED_BROWSER_DOM
agent-browser --session "$session" screenshot /home/user/workspace/native-browser.png
agent-browser --session "$session" close
trap - EXIT
printf 'OWNED_BROWSER_DOM_OK\\n'
"""
    with packaged_audit.capture() as audit:
        result = as_role(
            "workload", ["/bin/bash", "-c", script], env=env, group="tools", timeout=40
        )
    identity = (
        json.loads(result.stdout.splitlines()[0])
        if result.stdout.startswith("{")
        else {}
    )
    path = Path("/home/user/workspace/native-browser.png")
    png = path.read_bytes() if path.exists() else b""
    screenshot = {"bytes": len(png), "sha256": hashlib.sha256(png).hexdigest()}
    if len(png) >= 24 and png.startswith(b"\x89PNG\r\n\x1a\n"):
        screenshot.update(
            zip(("width", "height"), struct.unpack(">II", png[16:24]), strict=True)
        )
    record(
        "workload_browser_dom",
        result.returncode == 0
        and identity == {"uid": 1000, "context": "system_u:system_r:workload_t"}
        and "OWNED_BROWSER_DOM_OK" in result.stdout.splitlines()
        and 0 < screenshot.get("width", 0) <= 8192
        and 0 < screenshot.get("height", 0) <= 8192,
        screenshot=screenshot,
        exit=result.returncode,
        identity=identity,
        stdout=result.stdout[-2000:],
        stderr=result.stderr[-4000:],
        audit=audit["denials"],
    )
