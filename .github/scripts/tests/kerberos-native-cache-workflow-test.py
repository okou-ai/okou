"""Protect exact native-cache identity and one main producer per namespace."""

import json
import sys

workflows = json.load(sys.stdin)
jobs = workflows["crates"]["jobs"]
producer = jobs["check"]
producer_restore = next(s for s in producer["steps"] if s.get("id") == "kerberos-cache")

consumers = (
    ("crates", "check", "cargo clippy"),
    ("crates", "check-docs", "cargo doc"),
    ("crates", "coverage", "cargo llvm-cov nextest"),
    ("crates", "runner-rootfs-process-test", "cargo test --no-run --profile local"),
    ("crates", "host-cpu-fairness-build", "runner-native-test-artifact.sh build"),
    ("crates", "guest-rpc-firecracker-build", "runner-native-test-artifact.sh build"),
    ("crates", "native-kerberos-runtime", "check-native-kerberos.sh"),
    ("crates", "native-gssapi-independent-peer", "check-native-gssapi-peer.sh"),
    ("runner-architecture", "compile", "runner-binary-build/build.sh build"),
    ("runner-image", "prewarm-rust-cache", "runner-binary-build/build.sh build"),
    ("release", "build-runner-release-assets", 'env "${guest_env[@]}" cargo build'),
)
for workflow, name, compiler in consumers:
    job = workflows[workflow]["jobs"][name]
    steps = job["steps"]
    configure = next(s for s in steps if "KERBEROS_NATIVE_CACHE_DIR=" in s.get("run", ""))
    restore = next(s for s in steps if s.get("id") == "kerberos-cache")
    assert restore["uses"].startswith("actions/cache/restore@")
    assert restore["with"]["path"] == "${{ env.KERBEROS_NATIVE_CACHE_DIR }}"
    expected_key = producer_restore["with"]["key"]
    if workflow != "crates":
        expected_key = expected_key.replace("kerberos-native-v3-", "kerberos-native-runner-v2-", 1)
        expected_key += "-${{ env.TARGET_TRIPLE }}"
        assert job["env"]["TARGET_TRIPLE"] == "${{ matrix.target }}"
    elif "TARGET_TRIPLE" in job.get("env", {}):
        expected_key += "-${{ env.TARGET_TRIPLE }}"
    assert restore["with"]["key"] == expected_key
    # Immutable Actions entries must turn over for helper source/notices as well
    # as dependency pins; otherwise a populated dependency-only entry stays stale.
    assert "hashFiles('crates/kerberos-worker/native/*')" in restore["with"]["key"]
    assert "runner.os" in restore["with"]["key"] and "runner.arch" in restore["with"]["key"]
    assert job["env"]["KERBEROS_NATIVE_BUILD_ENV"] == job["container"]["image"] == producer["container"]["image"]
    assert "env.KERBEROS_NATIVE_BUILD_ENV" in restore["with"]["key"]
    assert "restore-keys" not in restore["with"]
    compile_step = next(s for s in steps if compiler in s.get("run", ""))
    assert steps.index(configure) < steps.index(restore) < steps.index(compile_step)
    if name == "prewarm-rust-cache":
        # Do not restore native material when the existing Rust-cache routing
        # skips compilation, including an exact hit appearing during restore.
        assert configure["if"] == restore["if"] == compile_step["if"]
    assert not any("secrets." in str(value) for value in (configure, restore))


def kerberos_writer(step):
    if not step.get("uses", "").startswith("actions/cache/save@"):
        return False
    inputs = step["with"]
    # Either input can identify a misrouted writer before its pair is validated.
    return (
        inputs["path"] == producer_restore["with"]["path"]
        or "steps.kerberos-cache.outputs." in inputs["key"]
        or inputs["key"].startswith("kerberos-native-")
    )


main_miss = "github.ref == 'refs/heads/main' && steps.kerberos-cache.outputs.cache-hit != 'true'"
expected_writers = {
    ("crates", "check"): ("cargo clippy", main_miss),
    ("crates", "guest-rpc-firecracker-build"): ("runner-native-test-artifact.sh publish", main_miss),
    ("crates", "native-kerberos-runtime"): (
        "check-native-kerberos.sh",
        "github.ref == 'refs/heads/main' && runner.arch == 'ARM64' && steps.kerberos-cache.outputs.cache-hit != 'true'",
    ),
    ("release", "build-runner-release-assets"): ('env "${guest_env[@]}" cargo build', main_miss),
}
writers = [(workflow, name, s)
           for workflow, document in workflows.items()
           for name, job in document["jobs"].items()
           for s in job.get("steps", []) if kerberos_writer(s)]
assert len(writers) == len(expected_writers)
assert {(workflow, name) for workflow, name, _ in writers} == set(expected_writers)
for workflow, name, save in writers:
    job = workflows[workflow]["jobs"][name]
    steps = job["steps"]
    restore = next(s for s in steps if s.get("id") == "kerberos-cache")
    completed, condition = expected_writers[workflow, name]
    assert save["with"]["path"] == restore["with"]["path"]
    assert save["with"]["key"] == "${{ steps.kerberos-cache.outputs.cache-primary-key }}"
    assert save["if"] == condition
    assert steps.index(save) > next(i for i, s in enumerate(steps) if completed in s.get("run", ""))
    assert "secrets." not in str(save)

# Host writers are architecture-disjoint. Cross-target native and Runner keys
# are separate namespaces, each with one writer covering its eligible targets.
assert producer["runs-on"] == "ubuntu-latest"
assert jobs["native-kerberos-runtime"]["strategy"]["matrix"]["os"] == ["ubuntu-latest", "ubuntu-24.04-arm"]
release = workflows["release"]["jobs"]["build-runner-release-assets"]
assert release["runs-on"] == "ubuntu-latest"
assert release["strategy"]["matrix"]["target"] == ["aarch64-unknown-linux-musl", "x86_64-unknown-linux-musl"]
for workflow, name in (("runner-architecture", "compile"), ("runner-image", "prewarm-rust-cache")):
    assert workflows[workflow]["jobs"][name]["runs-on"] == release["runs-on"]
print("kerberos-native-cache-workflow-test: ok")
