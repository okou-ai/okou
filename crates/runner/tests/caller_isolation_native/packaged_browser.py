"""Read a synthetic local page with the real packaged browser toolchain."""

import json

import packaged_audit


def probe(env, as_role, record):
    script = """set -euo pipefail
session=okou-native-owned
trap 'agent-browser --session "$session" close >/dev/null 2>&1 || true' EXIT
python3 -c 'import json,os,pathlib; print(json.dumps({"uid":os.getuid(),"context":pathlib.Path("/proc/self/attr/current").read_text().rstrip("\\0")}))'
agent-browser --session "$session" open 'data:text/html,%3Cmain%20id%3D%22native-marker%22%3EOWNED_BROWSER_DOM%3C%2Fmain%3E'
marker=$(agent-browser --session "$session" get text '#native-marker')
test "$marker" = OWNED_BROWSER_DOM
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
    record(
        "workload_browser_dom",
        result.returncode == 0
        and identity == {"uid": 1000, "context": "system_u:system_r:workload_t"}
        and "OWNED_BROWSER_DOM_OK" in result.stdout.splitlines(),
        exit=result.returncode,
        identity=identity,
        stdout=result.stdout[-2000:],
        stderr=result.stderr[-4000:],
        audit=audit["denials"],
    )
