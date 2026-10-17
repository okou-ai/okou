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
    script = """import ctypes,errno,json,os
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
target=Path('/tmp')/('forged-cgroup-'+str(os.getpid()))
target.mkdir()
libc=ctypes.CDLL(None,use_errno=True)
try:
 result=libc.mount(b'none',os.fsencode(target),b'cgroup2',0,None)
 assert result==-1 and ctypes.get_errno() in (errno.EACCES,errno.EPERM),('cgroup mount',result,ctypes.get_errno())
 result=libc.mount(None,b'/sys/fs/cgroup',None,4096|32,None)
 assert result==-1 and ctypes.get_errno() in (errno.EACCES,errno.EPERM),('cgroup remount',result,ctypes.get_errno())
finally: target.rmdir()
status=Path('/proc/self/status').read_text()
print(json.dumps({'uid':os.getuid(),'context':Path('/proc/self/attr/current').read_text().rstrip('\\0'),'capEff':next(line.split()[1] for line in status.splitlines() if line.startswith('CapEff:'))}))
"""
    for role, nested in (
        ("workload", False),
        ("root", False),
        ("workload", True),
        ("root", True),
    ):
        command = ["/usr/bin/python3", "-c", script]
        if nested:
            command = ["/usr/bin/unshare", "--user", "--map-root-user", *command]
        result = as_role(role, command, env=env, group="tools")
        observed = json.loads(result.stdout) if result.stdout else {}
        root = role == "root"
        passed = (
            result.returncode == 0
            and observed.get("uid") == (0 if root or nested else 1000)
            and observed.get("context") == "system_u:system_r:workload_t"
            and observed.get("capEff")
            == ("000001ffffffffff" if root or nested else "0000000000000000")
        )
        record(
            ("root" if root else "user")
            + ("_namespace" if nested else "")
            + "_cgroup_migration_denied",
            passed,
            identity=observed,
            stderr=result.stderr[-1500:],
        )


def shared_memory_probe(env, as_role, record):
    script = """import json,mmap,os
from pathlib import Path
fd=os.memfd_create('owned-workload-memory',os.MFD_CLOEXEC)
try:
 os.ftruncate(fd,4096)
 with mmap.mmap(fd,4096) as region:
  region[:5]=b'owned'
  assert region[:5]==b'owned'
finally: os.close(fd)
path=Path('/dev/shm/native-owned-memory')
path.write_bytes(b'owned')
assert path.read_bytes()==b'owned'
path.unlink()
print(json.dumps({'uid':os.getuid(),'context':Path('/proc/self/attr/current').read_text().rstrip('\\0')}))
"""
    result = as_role(
        "workload", ["/usr/bin/python3", "-c", script], env=env, group="tools"
    )
    identity = json.loads(result.stdout) if result.returncode == 0 else {}
    record(
        "workload_shared_memory",
        result.returncode == 0
        and identity == {"uid": 1000, "context": "system_u:system_r:workload_t"},
        identity=identity,
        stderr=result.stderr[-2000:],
    )
