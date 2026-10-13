"""Protect exact native-cache identity and one main producer per namespace."""

import json
import sys

workflow = json.load(sys.stdin)
jobs = workflow["jobs"]
producer = jobs["check"]
producer_restore = next(s for s in producer["steps"] if s.get("id") == "kerberos-cache")

consumers = (
    ("check", "cargo clippy"),
    ("check-docs", "cargo doc"),
    ("host-cpu-fairness-build", "runner-native-test-artifact.sh build"),
    ("guest-rpc-firecracker-build", "runner-native-test-artifact.sh build"),
)
for name, compiler in consumers:
    job = jobs[name]
    steps = job["steps"]
    configure = next(s for s in steps if "KERBEROS_NATIVE_CACHE_DIR=" in s.get("run", ""))
    restore = next(s for s in steps if s.get("id") == "kerberos-cache")
    assert restore["uses"].startswith("actions/cache/restore@")
    assert restore["with"]["path"] == "${{ env.KERBEROS_NATIVE_CACHE_DIR }}"
    expected_key = producer_restore["with"]["key"]
    if name.endswith("-build"):
        expected_key += "-${{ env.TARGET_TRIPLE }}"
    assert restore["with"]["key"] == expected_key
    assert "build-dependencies.sh" in restore["with"]["key"]
    assert "runner.os" in restore["with"]["key"] and "runner.arch" in restore["with"]["key"]
    assert job["env"]["KERBEROS_NATIVE_BUILD_ENV"] == job["container"]["image"] == producer["container"]["image"]
    assert "env.KERBEROS_NATIVE_BUILD_ENV" in restore["with"]["key"]
    assert "restore-keys" not in restore["with"]
    compile_step = next(s for s in steps if compiler in s.get("run", ""))
    assert steps.index(configure) < steps.index(restore) < steps.index(compile_step)
    assert not any("secrets." in str(value) for value in (configure, restore))

writers = [(name, s) for name, job in jobs.items() for s in job.get("steps", [])
           if s.get("uses", "").startswith("actions/cache/save@")]
assert len(writers) == 2 and {name for name, _ in writers} == {"check", "guest-rpc-firecracker-build"}
for name in ("check-docs", "host-cpu-fairness-build"):
    assert not any(s.get("uses", "").startswith("actions/cache/save@") for s in jobs[name]["steps"])
for name, save in writers:
    steps = jobs[name]["steps"]
    restore = next(s for s in steps if s.get("id") == "kerberos-cache")
    completed = "cargo clippy" if name == "check" else "runner-native-test-artifact.sh publish"
    assert save["with"]["path"] == restore["with"]["path"]
    assert save["with"]["key"] == "${{ steps.kerberos-cache.outputs.cache-primary-key }}"
    assert save["if"] == "github.ref == 'refs/heads/main' && steps.kerberos-cache.outputs.cache-hit != 'true'"
    assert steps.index(save) > next(i for i, s in enumerate(steps) if completed in s.get("run", ""))
    assert "secrets." not in str(save)
print("kerberos-native-cache-workflow-test: ok")
