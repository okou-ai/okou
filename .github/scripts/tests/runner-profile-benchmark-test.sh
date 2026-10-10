#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
python3 - "$REPO_ROOT" <<'PY'
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

root = Path(sys.argv[1])
with tempfile.TemporaryDirectory(prefix="runner-profile-test-") as directory:
    scratch = Path(directory)
    repo = scratch / "repo"
    scripts = repo / ".github/scripts"
    scripts.mkdir(parents=True)
    for name in ["runner-binary-build", "runner-profile-benchmark"]:
        shutil.copytree(root / ".github/scripts" / name, scripts / name)
    crates = repo / "crates"
    (crates / "runner").mkdir(parents=True)
    (crates / "Cargo.toml").write_text('''[workspace]
members = []
[profile.release]
lto = true
strip = true
codegen-units = 1
[profile.ci]
inherits = "release"
lto = "thin"
codegen-units = 4
''')
    (crates / "Cargo.lock").write_text("version = 4\n")
    (crates / "runner/guest-binaries.json").write_text(json.dumps([
        {"package": "guest-test", "binary": "guest-test", "pathEnv": "GUEST_TEST_PATH"}]))
    subprocess.run(["git", "init", "-q", str(repo)], check=True)
    subprocess.run(["git", "add", "."], cwd=repo, check=True)
    subprocess.run(["git", "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
                    "commit", "-qm", "test fixture"], cwd=repo, check=True)
    source = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip()
    cli = scratch / "package.tgz"
    cli.write_bytes(b"synthetic CLI bytes")
    cli_manifest = scratch / "manifest.json"
    cli_manifest.write_text(json.dumps({"version": 1, "commitSha": source,
        "package": {"path": "package.tgz", "sha256": hashlib.sha256(cli.read_bytes()).hexdigest(), "size": cli.stat().st_size},
        "versions": {"cli": "1.0.0", "piAgentRuntime": "1.0.0", "piSdk": "1.0.0+okou.0123456789ab"},
        "sessionConstruction": {"digest": "a" * 64}}))
    mocks = scratch / "bin"
    mocks.mkdir()
    log = scratch / "cargo.jsonl"
    cargo = mocks / "cargo"
    cargo.write_text('''#!/usr/bin/env python3
import json, os, pathlib, subprocess, sys
args = sys.argv[1:]
if args[0] == "--version":
    print("cargo fixture"); sys.exit(0)
if args[0] in ["fetch", "metadata"]:
    print("{}"); sys.exit(0)
target = pathlib.Path(os.environ["CARGO_TARGET_DIR"])
packages = [args[i+1] for i, arg in enumerate(args) if arg == "-p"]
assert "--locked" in args and "--timings" in args and args[args.index("--profile")+1] == "ci"
if packages != ["runner"]:
    assert not target.exists(), "Cargo outputs must be fresh before every guest phase"
else:
    assert pathlib.Path(os.environ["GUEST_TEST_PATH"]).is_file(), "same-trial guest is required"
with open(os.environ["FIXTURE_LOG"], "a") as f:
    f.write(json.dumps({"packages":packages,"targetDir":str(target),"cacheDir":os.environ["SCCACHE_DIR"],"lto":os.environ["CARGO_PROFILE_CI_LTO"],"cgu":os.environ["CARGO_PROFILE_CI_CODEGEN_UNITS"]})+"\\n")
if os.environ.get("FAIL_CARGO"):
    sys.exit(17)
target_triple = args[args.index("--target")+1]
linker = os.environ["CARGO_TARGET_"+target_triple.upper().replace("-","_")+"_LINKER"]
status = subprocess.run([linker, "-fuse-ld=mold", "-static", "-Wl,--no-dynamic-linker", "-o", "runner-test"]).returncode
if status: sys.exit(status)
output = target / target_triple / "ci"
output.mkdir(parents=True, exist_ok=True)
for package in packages: (output / package).write_bytes(b"synthetic binary")
timing = target / "cargo-timings/cargo-timing.html"
timing.parent.mkdir(parents=True, exist_ok=True)
timing.write_text("<html>synthetic Cargo timing</html>")
''')
    linker = mocks / "x86_64-linux-musl-gcc"
    linker.write_text('''#!/usr/bin/env bash
set -euo pipefail
[[ "$*" == *-fuse-ld=mold* && "$*" == *-static* && "$*" == *--no-dynamic-linker* ]]
exit "${FAIL_LINKER:-0}"
''')
    shutil.copyfile(linker, mocks / "aarch64-linux-musl-gcc")
    sccache = mocks / "sccache"
    sccache.write_text('''#!/usr/bin/env python3
import json, os, pathlib, sys
cache=pathlib.Path(os.environ.get("SCCACHE_DIR", "."))
if sys.argv[1] == "--version": print("sccache fixture")
elif sys.argv[1] == "--start-server":
    assert not list(cache.iterdir()), "sccache seed must be empty"
    (cache/"retained").write_text("cache seed")
elif sys.argv[1] in ["--zero-stats", "--show-stats"]:
    assert (cache/"retained").exists(), "cache must survive target deletion"
    if sys.argv[1] == "--show-stats": print(json.dumps({"cache_hits": {"Rust": 1}}))
''')
    for name, value in [("rustc", "rustc fixture"), ("mold", "mold fixture")]:
        (mocks / name).write_text('#!/usr/bin/env bash\nprintf "%s\\n" "' + value + '"\n')
    (mocks / "rustup").write_text('#!/usr/bin/env bash\nprintf "%s\\n" "$(dirname "$0")/$2"\n')
    for path in mocks.iterdir(): path.chmod(0o755)
    env = {key: value for key, value in os.environ.items()
           if not key.startswith(("CARGO_PROFILE_", "SCCACHE_")) and key not in ["RUSTFLAGS", "CARGO_ENCODED_RUSTFLAGS"]}
    env.update({"PATH": str(mocks) + os.pathsep + env["PATH"], "FIXTURE_LOG": str(log),
        "RUNNER_TEMP": str(scratch), "GUEST_CLI_PATH": str(cli), "GUEST_CLI_MANIFEST_PATH": str(cli_manifest)})
    env["RUNNER_BINARY_ACTUAL_TOOLCHAIN_IMAGE"] = subprocess.check_output(
        ["bash", "-c", '. "$1"; printf "%s" "$RUNNER_BINARY_TOOLCHAIN_IMAGE"', "contract",
         str(scripts / "runner-binary-build/contract.env")], env=env, text=True)
    run = ["python3", str(scripts / "runner-profile-benchmark/run.py")]
    identities = set()
    for profile, target in [("baseline", "x86_64-unknown-linux-musl"), ("thin-cgu8", "x86_64-unknown-linux-musl"), ("off-cgu4", "aarch64-unknown-linux-musl")]:
        report = scratch / profile
        subprocess.run([*run, profile, target, str(report)], cwd=repo, env=env, check=True, stdout=subprocess.DEVNULL)
        manifest = json.loads((report / "manifest.json").read_text())
        identities.add(manifest["experimentId"])
        assert manifest["identity"]["sourceSha"] == source
        assert manifest["identity"]["cliPackageSha256"] == hashlib.sha256(cli.read_bytes()).hexdigest()
        assert manifest["experimentId"] != manifest["identity"]["baselineBinaryInputDigest"]
        summary = json.loads((report / "summary.json").read_text())
        assert len(summary["trials"]) == 4 and summary["warm"]["runner"]["samples"] == 3
        assert len(list(report.glob("*/linker-*.json"))) == 8
        assert all(path.suffix in [".json", ".html"] for path in report.rglob("*") if path.is_file())
        assert not any("binaryInputDigest" in path.read_text() for path in report.rglob("*.json"))
    assert len(identities) == 3, "profile/target inputs require distinct experiment identities"
    calls = [json.loads(line) for line in log.read_text().splitlines()]
    assert len(calls) == 24 and {call["lto"] for call in calls} == {"thin", "false"}
    assert {call["cgu"] for call in calls} == {"4", "8"}
    assert len({call["targetDir"] for call in calls[:8]}) == 1, "same target path avoids path-dependent cache keys"
    for flag, code in [("FAIL_CARGO", 17), ("FAIL_LINKER", 23)]:
        report = scratch / flag
        failed = subprocess.run([*run, "baseline", "x86_64-unknown-linux-musl", str(report)], cwd=repo,
                                env={**env, flag: str(code)}, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        assert failed.returncode == code and not (report / "summary.json").exists()
        assert json.loads((report / "cold-1/guest.json").read_text())["exitCode"] == code
    contaminated = subprocess.run([*run, "baseline", "x86_64-unknown-linux-musl", str(scratch / "contaminated")],
                                 cwd=repo, env={**env, "SCCACHE_BUCKET": "shared"}, capture_output=True, text=True)
    assert contaminated.returncode != 0 and "clean profile/rustflags/sccache environment" in contaminated.stderr
    linked_cli = scratch / "linked-package.tgz"
    linked_cli.symlink_to(cli)
    rejected = subprocess.run([*run, "baseline", "x86_64-unknown-linux-musl", str(scratch / "linked-input")],
                              cwd=repo, env={**env, "GUEST_CLI_PATH": str(linked_cli)}, capture_output=True, text=True)
    assert rejected.returncode != 0 and "not a nonempty regular file" in rejected.stderr

print("runner-profile-benchmark tool-boundary tests: ok")
PY

# Assert the actual workflow's artifact/DAG boundary, not a synthetic YAML fixture.
ruby -ryaml -e '
workflow = YAML.load_file(ARGV.fetch(0))
raise "read-only permissions required" unless workflow.fetch("permissions") == {"contents" => "read"}
raise "diagnostic events only" unless workflow.fetch(true).keys.sort == %w[pull_request workflow_dispatch]
job = workflow.fetch("jobs").fetch("measure")
raise "production runner class required" unless job.fetch("runs-on") == "ubuntu-latest-8-cores"
raise "bounded six-lane experiment required" unless job.fetch("timeout-minutes") <= 40 && job.fetch("strategy").fetch("matrix").fetch("profile").length == 3 && job.fetch("strategy").fetch("matrix").fetch("target").length == 2
upload = job.fetch("steps").find { |step| step["name"] == "Upload diagnostic reports only" }
raise "upload only reports" unless upload.fetch("with").fetch("path") == "runner-profile-report"
raise "no production cache or deploy credentials" if File.read(ARGV.fetch(0)).match?(/secrets\.|setup-r2-sccache|rust-cache@|runner-binary-cache\.sh|runner-binary-transport\.sh/)
' "${REPO_ROOT}/.github/workflows/runner-profile-benchmark.yml"

echo "runner-profile-benchmark-test: ok"
