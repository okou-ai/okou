"""Protect exact native-cache ownership without weakening compiler gates."""

import json
import sys

workflow = json.load(sys.stdin)
job = workflow["jobs"]["check"]
steps = job["steps"]
configure = next(s for s in steps if s.get("name") == "Configure pinned Kerberos cache")
restore = next(s for s in steps if s.get("id") == "kerberos-cache")
save = next(s for s in steps if s.get("name") == "Save pinned Kerberos dependencies")
pin = "55cc8345863c7cc4c66a329aec7e433d2d1c52a9"
assert restore["uses"] == "actions/cache/restore@" + pin
assert save["uses"] == "actions/cache/save@" + pin
assert restore["with"]["path"] == save["with"]["path"] == "${{ env.KERBEROS_NATIVE_CACHE_DIR }}"
assert configure["run"] == 'echo "KERBEROS_NATIVE_CACHE_DIR=$RUNNER_TEMP/kerberos-native-cache" >> "$GITHUB_ENV"'
assert "build-dependencies.sh" in restore["with"]["key"]
assert "runner.os" in restore["with"]["key"] and "runner.arch" in restore["with"]["key"]
assert "restore-keys" not in restore["with"]
assert save["with"]["key"] == "${{ steps.kerberos-cache.outputs.cache-primary-key }}"
assert save["if"] == "github.ref == 'refs/heads/main' && steps.kerberos-cache.outputs.cache-hit != 'true'"
names = [s.get("name") for s in steps]
assert names.index(configure["name"]) < names.index(restore["name"]) < names.index("Run clippy") < names.index("Build documentation") < names.index(save["name"])
assert next(s for s in steps if s.get("name") == "Run clippy")["run"] == "cd crates\ncargo clippy --all-targets --all-features\n"
assert next(s for s in steps if s.get("name") == "Build documentation")["run"] == "cd crates\ncargo doc --workspace --all-features --no-deps\n"
assert job["timeout-minutes"] == 20 and steps[-1]["name"] == "Report peak memory"
assert not any("secrets." in str(value) for value in (configure, restore, save))
assert not any("KERBEROS_NATIVE_CACHE_DIR" in j.get("env", {}) for name, j in workflow["jobs"].items() if name != "check")
print("kerberos-native-cache-workflow-test: ok")
