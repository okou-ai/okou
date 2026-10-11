"""Temporary same-image primary-cold/dependency-warm acceptance experiment."""

import importlib.util
import json
from pathlib import Path
import statistics
import subprocess
import time


ROOT = Path.cwd()
WORKSPACE = ROOT / "crates"
spec = importlib.util.spec_from_file_location("selection", ROOT / ".github/scripts/select-clippy-packages.py")
selector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(selector)
host = next(line[6:] for line in subprocess.check_output(["rustc", "-vV"], text=True).splitlines()
            if line.startswith("host: "))
metadata = json.loads(selector.cargo_output(["metadata", "--locked", "--all-features", "--format-version", "1",
                                           "--filter-platform", host], WORKSPACE))
members = sorted(p["name"] for p in metadata["packages"] if p["id"] in metadata["workspace_members"])
started = time.monotonic()
selection = selector.select(metadata, ["crates/runner-host/src/lib.rs"], ROOT)
selection_seconds = time.monotonic() - started
assert selection["mode"] == "selected"
global_plan = selector.plan(ROOT, "pull_request", "HEAD^")
assert global_plan["mode"] == "full"
print("CLIPPY_BENCH_PLAN " + json.dumps({"source": subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip(),
                                      "rustc": subprocess.check_output(["rustc", "--version"], text=True).strip(),
                                      "selection": selection, "selection_seconds": selection_seconds,
                                      "global": global_plan, "state": "primary-cold/dependency-warm; unchanged native cache"}), flush=True)
clean = ["cargo", "clean"] + [arg for name in members for arg in ["-p", name]]
command = ["cargo", "clippy", "--all-targets", "--all-features", "--message-format=json"]
records = []
baseline_features = None
for mode in ["full", "selected", "selected", "full"]:
    subprocess.run(clean, cwd=WORKSPACE, check=True, stdout=subprocess.DEVNULL)
    actual = command + ([arg for name in selection["selected"] for arg in ["-p", name]] if mode == "selected" else [])
    print("CLIPPY_BENCH_START " + json.dumps({"mode": mode, "command": actual}), flush=True)
    started = time.monotonic()
    result = subprocess.run(actual, cwd=WORKSPACE, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    duration = time.monotonic() - started
    features = set()
    for line in result.stdout.splitlines():
        value = json.loads(line)
        if value.get("reason") == "compiler-artifact":
            features.add((value["package_id"], value["target"]["name"], tuple(value["target"]["kind"]),
                          value["profile"]["test"], tuple(value["features"])))
        elif value.get("reason") == "compiler-message" and value["message"]["level"] == "error":
            print(value["message"]["rendered"], flush=True)
    if result.returncode:
        print(result.stderr, flush=True)
        raise SystemExit(result.returncode)
    if baseline_features is None:
        baseline_features = features
    differences = features - baseline_features
    if differences:
        print("CLIPPY_BENCH_FEATURE_MISMATCH " + json.dumps(sorted(differences)), flush=True)
        raise SystemExit(1)
    record = {"mode": mode, "seconds": duration, "artifact_feature_records": len(features), "feature_mismatches": len(differences)}
    records.append(record)
    print("CLIPPY_BENCH_SAMPLE " + json.dumps(record), flush=True)
full_median = statistics.median(r["seconds"] for r in records if r["mode"] == "full")
selected_median = statistics.median(r["seconds"] for r in records if r["mode"] == "selected")
print("CLIPPY_BENCH_RESULT " + json.dumps({"samples": records, "full_median": full_median,
                                        "selected_median": selected_median,
                                        "change_percent": 100 * (selected_median / full_median - 1),
                                        "selected": len(selection["selected"]), "total": len(members)}), flush=True)
