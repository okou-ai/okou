"""Pi resource admission probes for the disposable native Guest only."""

import json
import os
from pathlib import Path

PI_ANCHORS = (
    "/home",
    "/home/user",
    "/home/user/workspace",
    "/home/user/.pi",
    "/home/user/.pi/agent",
    "/home/user/.pi/agent/sessions",
    "/home/user/workspace/.pi",
    "/home/.pi",
    "/.pi",
)


def prepare(fixture, label):
    """Freeze discovery roots while retaining ordinary files and session data."""
    for name in PI_ANCHORS:
        path = Path(name)
        path.mkdir(parents=True, exist_ok=True)
        if name != "/home":
            os.chown(path, 1000, 1000)
        label(path, "resource_anchor_t")
    home = fixture / "pi-resources"
    project = fixture / "project-resources"
    for path in (
        home / "agent" / "sessions",
        home / "agent" / "extensions",
        project / "extensions",
    ):
        path.mkdir(parents=True)
    for path in (home / "agent", project):
        os.chown(path, 1000, 1000)
        label(path, "resource_config_t")
    auth = home / "agent" / "auth.json"
    auth.write_text("{}")
    os.chown(auth, 1000, 1000)
    os.chmod(auth, 0o600)
    label(auth, "agent_state_t")
    (home / "agent/settings.json").write_text(
        json.dumps({"extensions": [], "packages": [], "projectTrusted": True})
    )
    (project / "settings.json").write_text(
        json.dumps({"extensions": [], "packages": []})
    )
    bootstrap = fixture / "bundled-loader-control.mjs"
    bootstrap.write_text("globalThis.PI_BUNDLED_NODE=true;\n")


def loader_script():
    return """globalThis.PI_BUNDLED_NODE=true;
const {createAgentSessionServices}=await import("/usr/local/lib/okou-cli/9.400.3/chunk-D5UXOEXQ.js");
const services=await createAgentSessionServices({cwd:process.cwd(),agentDir:"/home/user/.pi/agent",modelRuntime:{refresh:async()=>{}}});
const result=services.resourceLoader.getExtensions();
console.log(JSON.stringify({extensions:result.extensions.map(e=>e.path),errors:result.errors}));"""


def cgroup_probes(env, as_role, record):
    script = """import errno,json,os
from pathlib import Path
base=Path('/sys/fs/cgroup/vm0-exec/exec-native/workload')
for path in (base/'runtime/cgroup.procs',base/'runtime/cgroup.threads',base/'tools/cgroup.procs'):
 try: fd=os.open(path,os.O_WRONLY)
 except OSError as e: assert e.errno in (errno.EACCES,errno.EPERM,errno.EROFS),e
 else:
  try:
   try: os.write(fd,b'0')
   except OSError as e: assert e.errno in (errno.EACCES,errno.EPERM,errno.EROFS),e
   else: raise AssertionError('workload migrated through '+str(path))
  finally: os.close(fd)
try: (base/'forged-runtime').mkdir()
except OSError as e: assert e.errno in (errno.EACCES,errno.EPERM,errno.EROFS),e
else: raise AssertionError('workload created a resource domain')
status=Path('/proc/self/status').read_text()
print(json.dumps({'uid':os.getuid(),'context':Path('/proc/self/attr/current').read_text().rstrip('\\0'),'capEff':next(line.split()[1] for line in status.splitlines() if line.startswith('CapEff:'))}))
"""
    for role in ("workload", "root"):
        result = as_role(
            role, ["/usr/bin/python3", "-c", script], env=env, group="tools"
        )
        observed = json.loads(result.stdout) if result.stdout else {}
        root = role == "root"
        passed = (
            result.returncode == 0
            and observed.get("uid") == (0 if root else 1000)
            and observed.get("context") == "system_u:system_r:workload_t"
            and observed.get("capEff")
            == ("000001ffffffffff" if root else "0000000000000000")
        )
        record(
            ("root" if root else "user") + "_cgroup_migration_denied",
            passed,
            identity=observed,
            stderr=result.stderr[-1500:],
        )
