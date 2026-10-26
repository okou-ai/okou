#!/usr/bin/env python3
"""Replay full publication against real immutable builder evidence and fenced R2.

Runs only on the experiment branch via workflow_dispatch. Replayed subprocesses
receive the historical builder identity, independently verified by the real
GitHub API. No GitHub responses are replaced. Only the R2 key namespace changes;
the production publish/consume CLI, conditional writes and checksums stay real.
"""

import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time


BASELINE = "a58905f3d24b473202c28ba520507bf17463bb28"
BUILDER = "873dab4cc993a589f7dda7f1ef8fa323e2e31e9a"
BUILDER_RUN = 40271129677
BUILDER_ATTEMPT = 1
REPOSITORY = "okou-ai/okou"
ROUTE = f"repos/{REPOSITORY}/actions/runs/{BUILDER_RUN}/attempts/{BUILDER_ATTEMPT}"
ROOT = Path(os.environ["RUNNER_TEMP"]) / "publisher-provenance-replay"
RESULTS = ROOT / "results"


def command(*args, **kwargs):
    return subprocess.check_output(args, text=True, **kwargs).strip()


def save(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n")


def prepare():
    if (
        os.environ["GITHUB_EVENT_NAME"] != "workflow_dispatch"
        or os.environ["GITHUB_REPOSITORY"] != REPOSITORY
        or os.environ["GITHUB_REF"]
        != "refs/heads/ci/ios-archive-publish-overlap-experiment"
    ):
        raise ValueError("Publisher replay is restricted to its explicit experiment")
    ROOT.mkdir()
    RESULTS.mkdir()
    source = ROOT / "source"
    source.mkdir()
    for name, revision in (("baseline", BASELINE), ("candidate", "HEAD")):
        (source / f"{name}.py").write_text(
            command("git", "show", f"{revision}:ios/scripts/archive-promotion.py")
            + "\n"
        )
    run = json.loads(command("gh", "api", ROUTE))
    if (
        run["head_sha"] != BUILDER
        or run["event"] != "merge_group"
        or run["path"] != ".github/workflows/ios.yml"
        or not run["head_branch"].startswith("gh-readonly-queue/main/")
        or run["conclusion"] != "success"
    ):
        raise ValueError("Expected the exact successful historical merge group")
    save(RESULTS / "builder-run.json", run)
    subprocess.run(
        ["git", "fetch", "--no-tags", "--depth=1", "origin", BUILDER], check=True
    )
    subprocess.run(
        ["git", "worktree", "add", "--detach", str(ROOT / "builder"), BUILDER],
        check=True,
    )
    proof = ROOT / "proof"
    proof.mkdir()
    for name in ("ios-promotion", "ios-tests", "ios-package-tests"):
        subprocess.run(
            ["gh", "run", "download", str(BUILDER_RUN), "--repo", REPOSITORY,
             "--name", f"{name}-{BUILDER}-{BUILDER_ATTEMPT}", "--dir", str(proof)],
            check=True,
        )
    target = json.loads((proof / "inputs.json").read_text())
    for name in ("test-inputs.json", "package-inputs.json"):
        if json.loads((proof / name).read_text()) != target:
            raise ValueError("Historical native inputs do not agree")
    if (proof / "ran-tests.txt").read_text().strip() != "true":
        raise ValueError("The reference builder must have run every native suite")
    archive_prefix = (
        f"okou-ios/archives/{target['archiveInputSha256']}/{BUILDER}/"
        f"{BUILDER_RUN}/{BUILDER_ATTEMPT}"
    )
    keys = [
        f"okou-ios/tests/{target['testInputSha256']}/evidence.json",
        f"{archive_prefix}/archive.tar.gz",
        f"{archive_prefix}/manifest.json",
        f"okou-ios/inputs/{target['archiveInputSha256']}/ready.json",
        f"okou-ios/releases/{BUILDER}/mapping.json",
    ]
    save(ROOT / "keys.json", keys)
    wrappers = ROOT / "bin"
    wrappers.mkdir()
    proxy = Path(__file__).with_name("publisher-external-proxy.py").resolve()
    trace = ROOT / "trace-bin"
    trace.mkdir()
    for name in ("aws", "gh"):
        destination = (wrappers if name == "aws" else trace) / name
        shutil.copyfile(proxy, destination)
        destination.chmod(0o755)
    save(
        ROOT / "context.json",
        {
            "actual_run_id": os.environ["GITHUB_RUN_ID"],
            "actual_attempt": os.environ["GITHUB_RUN_ATTEMPT"],
            "experiment_sha": command("git", "rev-parse", "HEAD"),
            "real_aws": shutil.which("aws"),
            "real_gh": shutil.which("gh"),
            "ios_version": command("git", "show", f"{BUILDER}:ios/version.txt"),
            "comparison_order": ["A1", "B1", "B2", "A2"],
            "blocks": 3,
            "trace_block": 1,
            "timed_blocks": [2, 3],
            "acceptance": "All publication/unchanged-consumer/cleanup checks pass; in each timed block both candidates are faster than both controls, and median savings are at least one second. No full-CI speedup claim from publisher-only timing.",
            "clock": "full publish CLI wall time; download/setup/consume/cleanup separate",
        },
    )
    shutil.copyfile(ROOT / "context.json", RESULTS / "plan.json")


def run_block(number):
    context = json.loads((ROOT / "context.json").read_text())
    keys = json.loads((ROOT / "keys.json").read_text())
    for label in context["comparison_order"]:
        trial = f"{number}-{label}"
        directory = RESULTS / trial
        directory.mkdir()
        prefix = (
            "okou-ios/experiments/publisher-provenance/"
            f"{context['actual_run_id']}/{context['actual_attempt']}/{trial}/"
        )
        work = ROOT / f"work-{trial}"
        shutil.copytree(ROOT / "proof", work)
        variant = "baseline" if label.startswith("A") else "candidate"
        env = os.environ | {
            "PATH": (str(ROOT / "trace-bin") + os.pathsep if number == 1 else "")
            + str(ROOT / "bin") + os.pathsep + os.environ["PATH"],
            "PUBLISHER_REAL_AWS": context["real_aws"],
            "PUBLISHER_REAL_GH": context["real_gh"],
            "PUBLISHER_REPLAY_PREFIX": prefix,
            "PUBLISHER_REPLAY_KEYS": str(ROOT / "keys.json"),
            "PUBLISHER_REPLAY_ROUTE": ROUTE,
            "PUBLISHER_REPLAY_LOG": str(directory / "publish-calls.jsonl"),
            # This is an explicit replay of this real builder, not the current event.
            "GITHUB_EVENT_NAME": "merge_group",
            "GITHUB_REPOSITORY": REPOSITORY,
            "GITHUB_RUN_ID": str(BUILDER_RUN),
            "GITHUB_RUN_ATTEMPT": str(BUILDER_ATTEMPT),
            "GITHUB_REF": "refs/heads/main",
            "IOS_RAN_TESTS": "true",
            "IOS_VERSION": context["ios_version"],
        }
        started = time.monotonic()
        result = subprocess.run(
            [sys.executable, str(ROOT / "source" / f"{variant}.py"), "publish", str(work)],
            env=env, cwd=ROOT / "builder", capture_output=True, timeout=600,
        )
        elapsed = time.monotonic() - started
        (directory / "publish.stdout").write_bytes(result.stdout)
        (directory / "publish.stderr").write_bytes(result.stderr)
        summary = {"trial": trial, "variant": variant, "publish_seconds": elapsed,
                   "exit_code": result.returncode, "namespace": prefix}
        save(directory / "summary.json", summary)
        if result.returncode:
            raise RuntimeError(f"Publication replay failed for {trial}; no replay performed")
        calls = [json.loads(line) for line in (directory / "publish-calls.jsonl").read_text().splitlines()]
        summary["github_trace_enabled"] = number == 1
        summary["github_cli_calls"] = sum(c["service"] == "gh" for c in calls) if number == 1 else None
        summary["r2_cli_calls"] = sum(c["service"] == "aws" for c in calls)
        consume = ROOT / f"consume-{trial}"
        consume.mkdir()
        shutil.copyfile(work / "inputs.json", consume / "inputs.json")
        env["PUBLISHER_REPLAY_LOG"] = str(directory / "consume-calls.jsonl")
        # The unchanged consumer independently verifies the real archive and evidence.
        checked = subprocess.run(
            [sys.executable, str(ROOT / "source/baseline.py"), "consume", str(consume),
             "--wait-seconds", "0"],
            env=env, cwd=ROOT / "builder", capture_output=True, timeout=600,
        )
        (directory / "consume.stdout").write_bytes(checked.stdout)
        (directory / "consume.stderr").write_bytes(checked.stderr)
        summary["consumer_exit_code"] = checked.returncode
        save(directory / "summary.json", summary)
        if checked.returncode:
            raise RuntimeError(f"Unchanged consumer rejected {trial}")
        shutil.copyfile(consume / "release-mapping.json", directory / "release-mapping.json")
        cleanup = []
        for key in keys:
            owned = prefix + key
            if not owned.startswith(prefix) or key not in keys:
                raise ValueError("Refusing cleanup outside the owned experiment")
            deleted = subprocess.run(
                [context["real_aws"], "s3api", "delete-object", "--endpoint-url",
                 f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
                 "--bucket", os.environ["R2_BUCKET_NAME"], "--key", owned],
                capture_output=True, check=False,
            )
            cleanup.append({"key": owned, "exit_code": deleted.returncode})
        save(directory / "cleanup.json", cleanup)
        if any(c["exit_code"] for c in cleanup):
            raise RuntimeError(f"Owned experiment cleanup failed for {trial}")
        summary["cleanup_complete"] = True
        save(directory / "summary.json", summary)
        print(json.dumps(summary), flush=True)
        shutil.rmtree(work)
        shutil.rmtree(consume)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("prepare", "run-block"))
    parser.add_argument("--block", type=int, choices=(1, 2, 3))
    args = parser.parse_args()
    if args.operation == "run-block" and args.block is None:
        parser.error("run-block requires --block")
    prepare() if args.operation == "prepare" else run_block(args.block)
