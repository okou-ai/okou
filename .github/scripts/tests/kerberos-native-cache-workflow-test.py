"""Protect exact native-cache identity and its single main producer."""

import json
import sys

workflow = json.load(sys.stdin)
jobs = workflow["jobs"]
pin = "55cc8345863c7cc4c66a329aec7e433d2d1c52a9"
producer = jobs["check"]
producer_restore = next(s for s in producer["steps"] if s.get("id") == "kerberos-cache")

for name, compiler in (("check", "Run clippy"), ("check-docs", "Build documentation")):
    job = jobs[name]
    steps = job["steps"]
    configure = next(s for s in steps if s.get("name") == "Configure pinned Kerberos cache")
    restore = next(s for s in steps if s.get("id") == "kerberos-cache")
    assert restore["uses"] == "actions/cache/restore@" + pin
    assert restore["with"]["path"] == "${{ env.KERBEROS_NATIVE_CACHE_DIR }}"
    assert configure["run"] == 'echo "KERBEROS_NATIVE_CACHE_DIR=$RUNNER_TEMP/kerberos-native-cache" >> "$GITHUB_ENV"'
    assert restore["with"]["key"] == producer_restore["with"]["key"]
    assert "build-dependencies.sh" in restore["with"]["key"]
    assert "runner.os" in restore["with"]["key"] and "runner.arch" in restore["with"]["key"]
    assert job["env"]["KERBEROS_NATIVE_BUILD_ENV"] == job["container"]["image"] == producer["container"]["image"]
    assert "env.KERBEROS_NATIVE_BUILD_ENV" in restore["with"]["key"]
    assert "restore-keys" not in restore["with"]
    names = [s.get("name") for s in steps]
    assert names.index(configure["name"]) < names.index(restore["name"]) < names.index(compiler)
    assert job["timeout-minutes"] == 20 and steps[-1]["name"] == "Report peak memory"
    assert not any("secrets." in str(value) for value in (configure, restore))

writers = [(name, s) for name, job in jobs.items() for s in job.get("steps", [])
           if s.get("name") == "Save pinned Kerberos dependencies"]
assert len(writers) == 1 and writers[0][0] == "check"
assert not any(s.get("uses", "").startswith("actions/cache/save@") for s in jobs["check-docs"]["steps"])
save = writers[0][1]
assert save["uses"] == "actions/cache/save@" + pin
assert save["with"]["path"] == producer_restore["with"]["path"]
assert save["with"]["key"] == "${{ steps.kerberos-cache.outputs.cache-primary-key }}"
assert save["if"] == "github.ref == 'refs/heads/main' && steps.kerberos-cache.outputs.cache-hit != 'true'"
assert producer["steps"].index(save) > next(i for i, s in enumerate(producer["steps"]) if s.get("name") == "Run clippy")
assert "secrets." not in str(save)
assert next(s for s in producer["steps"] if s.get("name") == "Run clippy")["run"] == "cd crates\ncargo clippy --all-targets --all-features\n"
assert next(s for s in jobs["check-docs"]["steps"] if s.get("name") == "Build documentation")["run"] == "cd crates\ncargo doc --workspace --all-features --no-deps\n"
print("kerberos-native-cache-workflow-test: ok")
