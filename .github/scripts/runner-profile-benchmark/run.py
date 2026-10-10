#!/usr/bin/env python3
"""Rebuild committed runner inputs into disposable, job-local experimental outputs."""

import argparse
import hashlib
import json
import os
import platform
import shutil
import statistics
import subprocess
import sys
import tempfile
import tomllib
from pathlib import Path

from instrument import cgroup_directory, optional_text

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
PROFILES = {
    "baseline": {"lto": "thin", "codegen-units": 4},
    "thin-cgu8": {"lto": "thin", "codegen-units": 8},
    "off-cgu4": {"lto": "false", "codegen-units": 4},
}
LINKERS = {
    "aarch64-unknown-linux-musl": "aarch64-linux-musl-gcc",
    "x86_64-unknown-linux-musl": "x86_64-linux-musl-gcc",
}


def capture(command, **kwargs):
    return subprocess.check_output(command, text=True, **kwargs).strip()


def sha256(path):
    with path.open("rb") as file:
        return hashlib.file_digest(file, "sha256").hexdigest()


def save(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("profile", choices=PROFILES)
    parser.add_argument("target", choices=LINKERS)
    parser.add_argument("report_directory", type=Path)
    args = parser.parse_args()
    report = args.report_directory.resolve()
    report.mkdir(parents=True, exist_ok=False)
    profile = PROFILES[args.profile]
    real_cargo = shutil.which("cargo")
    real_linker = shutil.which(LINKERS[args.target])
    if real_cargo is None or real_linker is None or shutil.which("sccache") is None:
        raise RuntimeError(
            "pinned toolchain cargo, musl linker and sccache are required"
        )
    # No inherited profile overrides or shared cache backend may enter the experiment.
    inherited = [key for key in os.environ if key.startswith("CARGO_PROFILE_")]
    remote_cache = [key for key in os.environ if key.startswith("SCCACHE_")]
    rustflags = [key for key in os.environ if key.endswith("RUSTFLAGS")]
    if inherited or remote_cache or rustflags:
        raise RuntimeError(
            "benchmark requires a clean profile/rustflags/sccache environment"
        )
    env = os.environ.copy()
    env.pop("GITHUB_OUTPUT", None)
    source = capture(
        [
            "git",
            "rev-parse",
            "--verify",
            env.get("RUNNER_BINARY_GIT_REVISION", "HEAD") + "^{commit}",
        ],
        cwd=REPO,
    )
    # Preserve symlinks for the canonical digest owner's regular-file guard.
    cli = Path(env["GUEST_CLI_PATH"]).absolute()
    cli_manifest = Path(env["GUEST_CLI_MANIFEST_PATH"]).absolute()
    env.update(
        {
            "GUEST_CLI_PATH": str(cli),
            "GUEST_CLI_MANIFEST_PATH": str(cli_manifest),
            "TARGET_TRIPLE": args.target,
            "RUNNER_BINARY_GIT_REVISION": source,
        }
    )
    owner = REPO / ".github/scripts/runner-binary-build"
    digest_output = capture([str(owner / "digest.sh"), args.target], cwd=REPO, env=env)
    contract = dict(line.split("=", 1) for line in digest_output.splitlines())
    if contract["toolchain-image"] != env["RUNNER_BINARY_ACTUAL_TOOLCHAIN_IMAGE"]:
        raise RuntimeError("benchmark toolchain does not match the canonical contract")
    with tempfile.TemporaryDirectory(
        prefix="runner-profile-benchmark-", dir=env["RUNNER_TEMP"]
    ) as scratch:
        work = Path(scratch)
        context = work / "source"
        target = work / "target"
        cache = work / "sccache"
        cache.mkdir()
        conf = work / "sccache.toml"
        conf.write_text("")
        env.update(
            {
                "RUNNER_BINARY_CONTEXT_ROOT": str(context),
                "CARGO_TARGET_DIR": str(target),
            }
        )
        subprocess.run(
            [str(owner / "build.sh"), "materialize"], cwd=REPO, env=env, check=True
        )
        subprocess.run(
            [
                str(context / ".github/scripts/runner-binary-build/context.sh"),
                "validate-workspace",
                str(context),
            ],
            env=env,
            check=True,
        )
        cargo_manifest = tomllib.loads((context / "crates/Cargo.toml").read_text())
        baseline = cargo_manifest["profile"]["ci"]
        if (
            baseline["lto"] != PROFILES["baseline"]["lto"]
            or baseline["codegen-units"] != PROFILES["baseline"]["codegen-units"]
        ):
            raise RuntimeError(
                "source ci profile changed; update the benchmark baseline before comparing"
            )
        identity = {
            "sourceSha": source,
            "baselineBinaryInputDigest": contract["binary-input-digest"],
            "target": args.target,
            "profileName": "ci",
            "profileOverrides": profile,
            "manifestProfiles": cargo_manifest["profile"],
            "toolchainImage": contract["toolchain-image"],
            "rustcVersion": capture(["rustc", "--version", "--verbose"]),
            "cargoVersion": capture([real_cargo, "--version"]),
            "sccacheVersion": capture(["sccache", "--version"]),
            "moldVersion": capture(["mold", "--version"]),
            "pythonVersion": platform.python_version(),
            "rustcSha256": sha256(Path(capture(["rustup", "which", "rustc"]))),
            "cargoSha256": sha256(Path(capture(["rustup", "which", "cargo"]))),
            "linkerSha256": sha256(Path(real_linker)),
            "moldSha256": sha256(Path(shutil.which("mold"))),
            "sccacheSha256": sha256(Path(shutil.which("sccache"))),
            "instrumentationSha256": {
                str(path.relative_to(HERE)): sha256(path)
                for path in [
                    HERE / "run.py",
                    HERE / "instrument.py",
                    HERE / "bin/cargo",
                    HERE / "bin/linker",
                ]
            },
            "cliPackageSha256": sha256(cli),
            "cliManifestSha256": sha256(cli_manifest),
            "cliCommitSha": json.loads(cli_manifest.read_text())["commitSha"],
        }
        group = cgroup_directory()
        experiment_id = hashlib.sha256(
            json.dumps(identity, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()
        manifest = {
            "schemaVersion": 1,
            "experimentId": experiment_id,
            "identity": identity,
            "candidate": args.profile,
            "host": {
                "requestedRunnerClass": "ubuntu-latest-8-cores",
                "machine": platform.machine(),
                "runnerName": env.get("RUNNER_NAME"),
                "cpuCount": os.cpu_count(),
                "uname": list(platform.uname()),
                "affinityCpuCount": len(os.sched_getaffinity(0)),
                "meminfo": Path("/proc/meminfo").read_text(),
                "cpuinfo": Path("/proc/cpuinfo").read_text(),
                "osRelease": Path("/etc/os-release").read_text(),
                "cgroupLimits": None
                if group is None
                else {
                    name: optional_text(group / name)
                    for name in ["cpu.max", "memory.max", "cpuset.cpus.effective"]
                },
            },
            "cacheCondition": "registry prefetched; empty job-local disk sccache seed; fresh Cargo outputs every trial",
            "coldSamples": 1,
            "warmSamples": 3,
            "limits": [
                "Local disk sccache is not production R2/target-cache restore or end-to-end required-check latency.",
                "One cold seed is descriptive; three warm samples do not establish P95.",
                "Child CPU excludes work delegated to the separately running sccache server; cgroup CPU is container scoped.",
                "Maximum child RSS is not aggregate memory; container memory is sampled, not a reset kernel memory.peak.",
                "Cargo units/linker invocations overlap; rustc frontend/codegen/LTO/payload work is not separately attributed.",
            ],
        }
        save(report / "manifest.json", manifest)
        subprocess.run(
            [real_cargo, "fetch", "--locked", "--target", args.target],
            cwd=context / "crates",
            env=env,
            check=True,
        )
        env.update(
            {
                "CARGO_PROFILE_CI_LTO": profile["lto"],
                "CARGO_PROFILE_CI_CODEGEN_UNITS": str(profile["codegen-units"]),
                "CARGO_INCREMENTAL": "0",
                "RUSTC_WRAPPER": shutil.which("sccache"),
                "SCCACHE_CONF": str(conf),
                "SCCACHE_DIR": str(cache),
                "SCCACHE_CACHE_SIZE": "4G",
                "SCCACHE_GHA_ENABLED": "false",
                "SCCACHE_IDLE_TIMEOUT": "0",
                "SCCACHE_SERVER_PORT": "24940",
                "RUNNER_BENCHMARK_REAL_CARGO": real_cargo,
                "RUNNER_BENCHMARK_REAL_LINKER": real_linker,
                "RUNNER_BINARY_INPUT_DIGEST": experiment_id,
                "PATH": str(HERE / "bin") + os.pathsep + env["PATH"],
                "CARGO_TARGET_"
                + args.target.upper().replace("-", "_")
                + "_LINKER": str(HERE / "bin/linker"),
            }
        )
        subprocess.run(["sccache", "--start-server"], env=env, check=True)
        trials = []
        try:
            for name in ["cold-1", "warm-1", "warm-2", "warm-3"]:
                if target.exists():
                    shutil.rmtree(target)
                trial = report / name
                trial.mkdir()
                metadata = work / "experimental-metadata.json"
                env.update(
                    {
                        "RUNNER_BENCHMARK_TRIAL_DIR": str(trial),
                        "RUNNER_BINARY_METADATA_PATH": str(metadata),
                    }
                )
                print(f"Benchmark {args.target}/{args.profile}/{name}", flush=True)
                subprocess.run(
                    [str(context / ".github/scripts/runner-binary-build/compile.sh")],
                    env=env,
                    check=True,
                )
                outputs = json.loads(metadata.read_text())
                if outputs["binaryInputDigest"] != experiment_id:
                    raise RuntimeError("experimental metadata identity mismatch")
                # Diagnostic hashes/sizes only. No canonical transport metadata or binary leaves the job.
                save(
                    trial / "outputs.json",
                    {
                        key: outputs[key]
                        for key in ["runnerSha256", "runnerSizeBytes", "guestSha256"]
                    },
                )
                phases = {
                    phase: json.loads((trial / f"{phase}.json").read_text())
                    for phase in ["guest", "runner"]
                }
                trials.append({"trial": name, "phases": phases})
        finally:
            subprocess.run(["sccache", "--stop-server"], env=env, check=False)
        summary = {"experimentId": experiment_id, "trials": trials, "warm": {}}
        for phase in ["guest", "runner"]:
            values = [trial["phases"][phase]["wallSeconds"] for trial in trials[1:]]
            summary["warm"][phase] = {
                "samples": len(values),
                "minSeconds": min(values),
                "medianSeconds": statistics.median(values),
                "maxSeconds": max(values),
            }
        save(report / "summary.json", summary)
        print(json.dumps(summary["warm"], indent=2), flush=True)


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as error:
        sys.exit(error.returncode)
