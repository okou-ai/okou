"""Paired real Pi startup samples, with open-FD cgroup peak accounting."""

import time


def cpu(path):
    return int(
        dict(line.split() for line in (path / "cpu.stat").read_text().splitlines())[
            "usage_usec"
        ]
    )


def probe(cgroup, env, pi_session, requests, record):
    samples = []
    for index in range(3):
        for role in ("agent-resource-control", "agent"):
            with (
                (cgroup / "memory.peak").open("r+b", buffering=0) as workload_peak,
                (cgroup / "runtime/memory.peak").open(
                    "r+b", buffering=0
                ) as runtime_peak,
            ):
                workload_peak.write(b"0")
                runtime_peak.write(b"0")
                before_cpu, runtime_cpu = cpu(cgroup), cpu(cgroup / "runtime")
                before = len(requests)
                started = time.monotonic()
                current = {
                    **env,
                    "OKOU_PI_SESSION_ID": f"dddddddd-dddd-4ddd-8ddd-{index * 2 + (role == 'agent') + 1:012d}",
                }
                status, events = pi_session(current, "PI_STARTUP_PROBE", role=role)
                elapsed = time.monotonic() - started
                observed = requests[before:]
                workload_peak.seek(0)
                runtime_peak.seek(0)
                samples.append(
                    {
                        "role": role,
                        "exit": status,
                        "settled": any(
                            event.get("type") == "agent_settled" for event in events
                        ),
                        "firstModelRequestSeconds": observed[0]["receivedMonotonic"]
                        - started
                        if len(observed) == 1
                        else None,
                        "settledSeconds": elapsed,
                        "workloadCpuUsec": cpu(cgroup) - before_cpu,
                        "runtimeCpuUsec": cpu(cgroup / "runtime") - runtime_cpu,
                        "workloadPeakBytes": int(workload_peak.read()),
                        "runtimePeakBytes": int(runtime_peak.read()),
                    }
                )
    record(
        "real_pi_paired_startup_accounting",
        len(samples) == 6
        and all(
            sample["exit"] == 0
            and sample["settled"] is True
            and isinstance(sample["firstModelRequestSeconds"], float)
            and 0 < sample["firstModelRequestSeconds"] <= sample["settledSeconds"]
            and 0 < sample["runtimeCpuUsec"] <= sample["workloadCpuUsec"]
            and 0 < sample["runtimePeakBytes"] <= sample["workloadPeakBytes"]
            for sample in samples
        ),
        samples=samples,
        qualification="same packaged CLI, kernel, Guest resources, peer and sealed OS; alternating discovery control/frozen views, fresh logical sessions; descriptive samples only, no saving or stable percentile claim",
    )
