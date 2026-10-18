"""Pi resource admission probes for the disposable native Guest only."""

import json
import os
import select
import shlex
import time
from pathlib import Path

import packaged_vendor_resources

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
    packaged_vendor_resources.prepare(fixture, label)


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


def nested_child_probe(root, env, as_role, tasks, record):
    nested = root / "nested-user-project"
    extension = nested / ".pi/extensions/probe.js"
    extension.parent.mkdir(parents=True)
    extension.write_text(
        'import fs from "node:fs"; export default function() { fs.writeFileSync("/home/user/workspace/nested-extension-executed", "untrusted project extension executed"); }'
    )
    for path in (nested, extension.parent.parent, extension.parent, extension):
        os.chown(path, 1000, 1000)
    command = (
        "cd "
        + shlex.quote(str(nested))
        + "; okou subagent start 'PI_NESTED_CWD'; python3 -c "
        + shlex.quote(
            "import pathlib,time; p=pathlib.Path('/home/user/workspace/nested-child-cwd'); deadline=time.monotonic()+15\nwhile not p.exists() and time.monotonic()<deadline: time.sleep(.02)\nassert p.exists(), 'nested child did not run its actual tool'\nprint(p.read_text())"
        )
    )
    before = set(tasks)
    run = as_role(
        "workload", ["/bin/bash", "-c", command], env=env, group="tools", timeout=25
    )
    observed = root / "nested-child-cwd"
    actual = observed.read_text().strip() if observed.exists() else None
    added = set(tasks) - before
    empty = False
    if len(added) == 1:
        family = tasks[added.pop()]
        with (family / "cgroup.events").open("rb", buffering=0) as events:
            observer = select.poll()
            observer.register(events, select.POLLPRI | select.POLLERR)
            deadline = time.monotonic() + 10
            while True:
                events.seek(0)
                state = dict(
                    line.split() for line in events.read().decode().splitlines()
                )
                if state.get("populated") == "0":
                    empty = True
                    break
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                observer.poll(max(1, int(remaining * 1000)))
    record(
        "real_pi_child_uses_captured_workspace",
        run.returncode == 0
        and empty
        and actual == str(root)
        and not (root / "nested-extension-executed").exists(),
        exit=run.returncode,
        requestedToolDirectory=str(nested),
        observedChildToolDirectory=actual,
        extensionExecuted=(root / "nested-extension-executed").exists(),
        familyUnpopulated=empty,
        contract="protected children use the Run-captured workspace; the arbitrary invoking tool directory is data, never executable discovery authority",
        stdout=run.stdout[-2000:],
        stderr=run.stderr[-2000:],
    )
