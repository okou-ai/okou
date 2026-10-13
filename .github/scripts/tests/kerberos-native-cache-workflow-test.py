"""Protect exact native-cache identity and one main producer per namespace."""

import json
import sys

workflow = json.load(sys.stdin)
jobs = workflow["jobs"]
pin = "55cc8345863c7cc4c66a329aec7e433d2d1c52a9"
producer = jobs["check"]
producer_restore = next(s for s in producer["steps"] if s.get("id") == "kerberos-cache")

consumers = (
    ("check", "Run clippy", 20),
    ("check-docs", "Build documentation", 20),
    ("host-cpu-fairness-build", "Cross-compile host CPU fairness test", 15),
    ("guest-rpc-firecracker-build", "Cross-compile native Guest RPC and duplex test", 15),
)
for name, compiler, timeout in consumers:
    job = jobs[name]
    steps = job["steps"]
    configure = next(s for s in steps if s.get("name") == "Configure pinned Kerberos cache")
    restore = next(s for s in steps if s.get("id") == "kerberos-cache")
    assert restore["uses"] == "actions/cache/restore@" + pin
    assert restore["with"]["path"] == "${{ env.KERBEROS_NATIVE_CACHE_DIR }}"
    assert configure["run"] == 'echo "KERBEROS_NATIVE_CACHE_DIR=$RUNNER_TEMP/kerberos-native-cache" >> "$GITHUB_ENV"'
    expected_key = producer_restore["with"]["key"]
    if name.endswith("-build"):
        expected_key += "-${{ env.TARGET_TRIPLE }}"
    assert restore["with"]["key"] == expected_key
    assert "build-dependencies.sh" in restore["with"]["key"]
    assert "runner.os" in restore["with"]["key"] and "runner.arch" in restore["with"]["key"]
    assert job["env"]["KERBEROS_NATIVE_BUILD_ENV"] == job["container"]["image"] == producer["container"]["image"]
    assert "env.KERBEROS_NATIVE_BUILD_ENV" in restore["with"]["key"]
    assert "restore-keys" not in restore["with"]
    names = [s.get("name") for s in steps]
    assert names.index(configure["name"]) < names.index(restore["name"]) < names.index(compiler)
    assert job["timeout-minutes"] == timeout and steps[-1]["name"] == "Report peak memory"
    assert not any("secrets." in str(value) for value in (configure, restore))

writers = [(name, s) for name, job in jobs.items() for s in job.get("steps", [])
           if s.get("name") == "Save pinned Kerberos dependencies"]
assert len(writers) == 2 and {name for name, _ in writers} == {"check", "guest-rpc-firecracker-build"}
for name in ("check-docs", "host-cpu-fairness-build"):
    assert not any(s.get("uses", "").startswith("actions/cache/save@") for s in jobs[name]["steps"])
for name, save in writers:
    steps = jobs[name]["steps"]
    restore = next(s for s in steps if s.get("id") == "kerberos-cache")
    completed = "Run clippy" if name == "check" else "Publish native test to R2"
    assert save["uses"] == "actions/cache/save@" + pin
    assert save["with"]["path"] == restore["with"]["path"]
    assert save["with"]["key"] == "${{ steps.kerberos-cache.outputs.cache-primary-key }}"
    assert save["if"] == "github.ref == 'refs/heads/main' && steps.kerberos-cache.outputs.cache-hit != 'true'"
    assert steps.index(save) > next(i for i, s in enumerate(steps) if s.get("name") == completed)
    assert "secrets." not in str(save)
assert next(s for s in producer["steps"] if s.get("name") == "Run clippy")["run"] == "cd crates\ncargo clippy --all-targets --all-features\n"
assert next(s for s in jobs["check-docs"]["steps"] if s.get("name") == "Build documentation")["run"] == "cd crates\ncargo doc --workspace --all-features --no-deps\n"
print("kerberos-native-cache-workflow-test: ok")
