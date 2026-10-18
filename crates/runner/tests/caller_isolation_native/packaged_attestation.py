"""Reject vacuous positive flags for the extended native qualification cases."""

import hashlib

from packaged_home import RETAINED


def positive_integer(value, limit=None):
    return type(value) is int and value > 0 and (limit is None or value <= limit)


def validate(cases):
    for runtime, version in (
        ("node", "v24.22.0"),
        ("claude", "2.1.302 (Claude Code)"),
        ("codex", "codex-cli 0.163.0"),
    ):
        case = cases[runtime + "_packaged_version"]
        if case.get("exit") != 0 or case.get("stdout", "").strip() != version:
            raise ValueError("wrong qualified packaged runtime version")
    initial, repeated = (
        cases[name] for name in ("home_helper_initialization", "home_helper_repeated")
    )
    for case in (initial, repeated):
        layout = case.get("layout")
        expected = (
            {
                name: hashlib.sha256(value).hexdigest()
                for name, value in RETAINED.items()
            }
            if layout == "retained"
            else {}
        )
        mounts = case.get("mount")
        if (
            layout not in ("fresh", "retained")
            or case.get("unlabelledSeed") is not True
            or case.get("helperExit") != 0
            or case.get("retainedSha256") != expected
            or not isinstance(mounts, list)
            or len(mounts) != 1
            or " / /home/user " not in mounts[0]
            or " - ext4 /dev/vdb " not in mounts[0]
            or "defcontext=system_u:object_r:workload_data_t" not in mounts[0]
        ):
            raise ValueError(
                "home qualification lacks the actual fixed unlabelled mount/helper evidence"
            )
    if (
        initial["layout"] != repeated["layout"]
        or initial.get("context") != "system_u:object_r:workload_data_t"
    ):
        raise ValueError("home layout or initial data context changed")
    home_data = cases["home_workload_retained_data"]
    observations = home_data.get("observations")
    if (
        home_data.get("layout") != initial["layout"]
        or not isinstance(observations, list)
        or [item.get("role") for item in observations] != ["workload", "root"]
        or any(
            item.get("exit") != 0
            or not isinstance(item.get("identity"), dict)
            or item["identity"].get("uid") != (0 if item["role"] == "root" else 1000)
            or item["identity"].get("context") != "system_u:system_r:workload_t"
            or item["identity"].get("retained") is not (initial["layout"] == "retained")
            for item in observations
        )
    ):
        raise ValueError("home data was not exercised by both real workload identities")
    for framework in ("claude", "codex"):
        observations = cases[framework + "_configuration_known_load_and_mask"].get(
            "observations"
        )
        if not isinstance(observations, list) or len(observations) != 2:
            raise ValueError("missing vendor known-load control")
        control, protected = observations
        identity = control.get("identity")
        if (
            control.get("role") != "agent-resource-control"
            or control.get("exit") != 0
            or control.get("ingressObserved") is not True
            or not isinstance(identity, dict)
            or identity.get("uid") != 1000
            or identity.get("context") != "system_u:system_r:agent_t"
            or identity.get("capEff") != "0000000000000000"
            or identity.get("connectErrno") != 0
            or identity.get("initialized") is not True
            or protected.get("role") != "agent"
            or protected.get("exit") != 0
            or protected.get("identity") is not None
            or protected.get("ingressObserved") is not False
        ):
            raise ValueError(
                "vendor denial is not qualified by the real load/handshake control"
            )
    gateway = cases["gateway_bounded_streaming_accounting"]
    identity = gateway.get("identity")
    observed = gateway.get("observed")
    if (
        not isinstance(identity, dict)
        or identity.get("context") != "system_u:system_r:gateway_t"
        or identity.get("cgroup") != "0::/vm0-exec/exec-native/workload/gateway"
        or not positive_integer(gateway.get("memoryPeakBytes"), 256 * 1024**2)
        or not positive_integer(gateway.get("pidsPeak"), 64)
        or not isinstance(observed, dict)
        or observed.get("overLimitStatus") != 413
        or observed.get("concurrentLimitStatus") != 503
        or observed.get("aggregateBodyLimitStatus") != 503
        or observed.get("directUpstreamDenied") is not True
    ):
        raise ValueError("gateway has no actual role/budget/IO qualification")
    samples = observed.get("observations")
    if (
        not isinstance(samples, list)
        or len(samples) != 8
        or {sample.get("port") for sample in samples} != {18080, 18083}
    ):
        raise ValueError("gateway lacks paired direct/proxy IO observations")
    if gateway["memoryPeakBytes"] < 32 * 1024**2 or gateway["pidsPeak"] < 18:
        raise ValueError(
            "gateway budgets were not actually exercised at their qualified boundaries"
        )
    oom = cases["gateway_local_oom_fails_closed"]
    if (
        oom.get("exit") != -9
        or not isinstance(oom.get("events"), dict)
        or int(oom["events"].get("oom_kill", "0")) <= 0
    ):
        raise ValueError("gateway did not demonstrate local OOM")
    for name in (
        "pi_inprocess_read_key",
        "pi_inprocess_write_config",
        "claude_inprocess_read_key",
        "claude_inprocess_write_config",
        "claude_inprocess_http",
        "codex_inprocess_read_key",
    ):
        case = cases[name]
        outputs = case.get("actualToolOutputs")
        if (
            case.get("exit") != 0
            or not isinstance(outputs, list)
            or not outputs
            or any(not isinstance(output, str) for output in outputs)
        ):
            raise ValueError("missing actual in-process tool completion/output")
    web = cases["claude_inprocess_http"]
    if (
        web.get("tlsIngressObserved") is not True
        or "405" not in " ".join(web["actualToolOutputs"])
        or web.get("upstreamGetDelta") != 0
    ):
        raise ValueError(
            "WebFetch denial relied on an unqualified transport/preflight failure"
        )
    resolver = cases["alternate_resolver_role_admission"]
    observations = resolver.get("observations")
    if (
        not isinstance(observations, list)
        or [item.get("role") for item in observations]
        != ["workload", "root", "agent", "gateway"]
        or len(resolver.get("actualRequests", [])) != 1
    ):
        raise ValueError("alternate resolver lacks real caller/request observations")
    for item in observations:
        identity = item.get("identity")
        target = (
            "gateway_t"
            if item["role"] == "gateway"
            else "agent_t"
            if item["role"] == "agent"
            else "workload_t"
        )
        if (
            item.get("exit") != 0
            or not isinstance(identity, dict)
            or identity.get("context") != "system_u:system_r:" + target
            or type(identity.get("connectErrno")) is not int
            or identity["connectErrno"]
            not in ((0,) if target == "gateway_t" else (1, 13))
        ):
            raise ValueError("alternate resolver admitted the wrong caller authority")
    samples = cases["real_pi_paired_startup_accounting"].get("samples")
    if (
        not isinstance(samples, list)
        or len(samples) != 6
        or sorted(item.get("role", "") for item in samples)
        != ["agent"] * 3 + ["agent-resource-control"] * 3
    ):
        raise ValueError("startup lacks paired real CLI samples")
    for sample in samples:
        first = sample.get("firstModelRequestSeconds")
        if (
            sample.get("exit") != 0
            or sample.get("settled") is not True
            or type(first) is not float
            or not 0 < first <= sample.get("settledSeconds", 0)
            or not positive_integer(sample.get("runtimeCpuUsec"))
            or not positive_integer(sample.get("workloadCpuUsec"))
            or sample["runtimeCpuUsec"] > sample["workloadCpuUsec"]
            or not positive_integer(sample.get("runtimePeakBytes"))
            or not positive_integer(sample.get("workloadPeakBytes"))
            or sample["runtimePeakBytes"] > sample["workloadPeakBytes"]
        ):
            raise ValueError("startup accounting is incomplete or inconsistent")
    child = cases["real_pi_child_uses_captured_workspace"]
    if (
        child.get("exit") != 0
        or child.get("observedChildToolDirectory") != "/home/user/workspace"
        or child.get("requestedToolDirectory")
        != "/home/user/workspace/nested-user-project"
        or child.get("extensionExecuted") is not False
        or child.get("familyUnpopulated") is not True
    ):
        raise ValueError("child launch trusts the invoking tool's discovery directory")
