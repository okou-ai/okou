"""Actual resource-controller observations in the owned prototype Guest."""

import base64
import json
import shlex
import subprocess
import threading
from contextlib import contextmanager
from pathlib import Path


def values(path):
    return dict(line.split() for line in path.read_text().splitlines())


@contextmanager
def protected_runtime(cgroup, env, pi_session, ready, release, record):
    outcome, failures = [], []

    def run():
        try:
            outcome.append(
                pi_session(
                    {
                        **env,
                        "OKOU_PI_SESSION_ID": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                    },
                    "PI_RESOURCE_WAIT",
                )
            )
        except (OSError, ValueError, subprocess.SubprocessError) as error:
            failures.append(str(error))

    worker = threading.Thread(target=run)
    worker.start()
    identities = {}
    try:
        if not ready.wait(12):
            raise TimeoutError("real Pi resource peer readiness")
        for raw in (cgroup / "runtime/cgroup.procs").read_text().splitlines():
            path = Path("/proc") / raw
            command = (path / "cmdline").read_bytes()
            if b"__agent-loop" in command and b"okou.js" in command:
                identities[raw] = (path / "attr/current").read_text().rstrip("\0")
        if len(identities) != 1 or set(identities.values()) != {
            "system_u:system_r:agent_t"
        }:
            raise ValueError("resource control lacks exactly one actual protected Pi")
        yield
        for raw, context in identities.items():
            if (Path("/proc") / raw / "attr/current").read_text().rstrip(
                "\0"
            ) != context:
                raise ValueError(
                    "protected Pi changed identity during resource pressure"
                )
    finally:
        release.set()
        worker.join(timeout=65)
        passed = (
            not worker.is_alive()
            and not failures
            and len(outcome) == 1
            and outcome[0][0] == 0
            and any(item.get("type") == "agent_settled" for item in outcome[0][1])
            and bool(identities)
        )
        record(
            "real_pi_continues_after_tool_oom",
            passed,
            identities=identities,
            failures=failures,
            exit=outcome[0][0] if outcome else None,
        )
        if worker.is_alive():
            raise TimeoutError("owned Pi resource control did not join")


def probe(cgroup, env, as_role, record, pi_session, ready, release):
    policy = json.loads(Path("/fixture/resource-policy.json").read_text())
    operation = cgroup.parent
    observed = {
        "cpuMax": (cgroup / "cpu.max").read_text().strip(),
        "memoryMax": int((cgroup / "memory.max").read_text()),
        "memoryHigh": (cgroup / "memory.high").read_text().strip(),
        "pidsMax": (cgroup / "pids.max").read_text().strip(),
        "controlMin": int((operation / "control/memory.min").read_text()),
        "runtimeMin": int((cgroup / "runtime/memory.min").read_text()),
        "controllerCgroup": Path("/proc/self/cgroup").read_text().strip(),
        "controllerMemory": int((operation / "control/memory.current").read_text()),
    }
    record(
        "production_resource_policy_applied",
        observed["cpuMax"] == f"{policy['cpuQuotaUs']} {policy['cpuPeriodUs']}"
        and observed["memoryMax"] == policy["memoryMaxBytes"]
        and observed["memoryHigh"] == "max"
        and observed["pidsMax"] == policy["pidsMax"]
        and observed["controlMin"] == policy["controlMemoryMinBytes"]
        and observed["runtimeMin"] == policy["runtimeMemoryMinBytes"]
        and observed["controllerCgroup"] == "0::/vm0-exec/exec-native/control"
        and observed["controllerMemory"] > 0,
        calculatedPolicy=policy,
        observed=observed,
    )

    def tool(script):
        command = shlex.join(["/usr/bin/python3", "-c", script])
        payload = base64.urlsafe_b64encode(command.encode()).decode().rstrip("=")
        before = set((cgroup / "tools").glob("tool-*"))
        result = as_role(
            "agent",
            [
                "/fixture/guest-tool-exec",
                f"--command-envelope=vm0.command.v1.{len(command.encode())}.{payload}",
                "--shell",
                "/bin/bash",
            ],
            env=env,
            timeout=45,
        )
        added = set((cgroup / "tools").glob("tool-*")) - before
        if len(added) != 1:
            raise ValueError("resource tool did not receive one owned leaf")
        return result, added.pop()

    cpu_before = int(values(cgroup / "cpu.stat")["usage_usec"])
    result, leaf = tool(
        "import json,os,pathlib; data=bytearray(16*1024*1024); data[::4096]=b'x'*(len(data)//4096); "
        "print(sum(i*i for i in range(1000000))); "
        "print(json.dumps({'uid':os.getuid(),'context':pathlib.Path('/proc/self/attr/current').read_text().rstrip('\\0'),"
        "'workloadPidsCurrent':int(pathlib.Path('/sys/fs/cgroup/vm0-exec/exec-native/workload/pids.current').read_text())}))"
    )
    leaf_cpu = int(values(leaf / "cpu.stat")["usage_usec"])
    workload_delta = int(values(cgroup / "cpu.stat")["usage_usec"]) - cpu_before
    memory_peak = int((leaf / "memory.peak").read_text())
    pids_peak = int((cgroup / "pids.peak").read_text())
    identity = (
        json.loads(result.stdout.splitlines()[-1]) if result.returncode == 0 else {}
    )
    record(
        "real_tool_resource_accounting",
        result.returncode == 0
        and identity.get("uid") == 1000
        and identity.get("context") == "system_u:system_r:workload_t"
        and identity.get("workloadPidsCurrent", 0) >= 1
        and 0 < leaf_cpu <= workload_delta
        and memory_peak >= 16 * 1024 * 1024
        and pids_peak >= 1
        and values(leaf / "cgroup.events")["populated"] == "0",
        leaf=str(leaf),
        toolCpuUsec=leaf_cpu,
        workloadCpuDeltaUsec=workload_delta,
        memoryPeakBytes=memory_peak,
        workloadPidsPeak=pids_peak,
        exit=result.returncode,
        identity=identity,
        stderr=result.stderr[-1000:],
    )
    oom_before = int(values(cgroup / "memory.events")["oom_kill"])
    with protected_runtime(cgroup, env, pi_session, ready, release, record):
        result, leaf = tool(
            "chunks=[]\n"
            "for _ in range(128):\n"
            " data=bytearray(16*1024*1024)\n"
            " for offset in range(0,len(data),4096): data[offset]=1\n"
            " chunks.append(data)\n"
            "raise AssertionError('bounded allocation did not trigger workload OOM')\n"
        )
    events = values(leaf / "memory.events")
    record(
        "real_tool_group_oom_contained",
        result.returncode != 0
        and int(events["oom_kill"]) > 0
        and int(values(cgroup / "memory.events")["oom_kill"]) > oom_before
        and (leaf / "memory.oom.group").read_text().strip() == "1"
        and values(leaf / "cgroup.events")["populated"] == "0"
        and Path("/sys/fs/selinux/enforce").read_text().strip() == "1",
        leaf=str(leaf),
        events=events,
        memoryPeakBytes=int((leaf / "memory.peak").read_text()),
        exit=result.returncode,
        stdout=result.stdout[-1000:],
        stderr=result.stderr[-1000:],
    )
