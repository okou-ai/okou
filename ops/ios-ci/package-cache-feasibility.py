"""Qualify native SwiftPM CAS replay; same-host timings are diagnostic only."""

import json
import os
import pathlib
import re
import shutil
import subprocess
import time

temporary = pathlib.Path(os.environ["RUNNER_TEMP"])
output = temporary / "package-cache-feasibility"
output.mkdir()
cache = temporary / "okou-package-compiler-cas"
build = temporary / "okou-ios-ci"
results = []
for label, cached in (("baseline", False), ("seed", True), ("fresh-build-replay", True)):
    for package in ("ChatDomain", "ChatData"):
        scratch = build / package
        if scratch.exists():
            shutil.rmtree(scratch)
    env = os.environ.copy()
    env.pop("IOS_PACKAGE_COMPILATION_CACHE_PATH", None)
    if cached:
        cache.mkdir(exist_ok=True)
        env["IOS_PACKAGE_COMPILATION_CACHE_PATH"] = str(cache)
    started = time.monotonic()
    with (output / f"{label}.log").open("wb") as stream:
        process = subprocess.run(["bash", "ios/scripts/ci-package-test.sh"],
                                 env=env, stdout=stream, stderr=subprocess.STDOUT)
    elapsed = time.monotonic() - started
    log = (output / f"{label}.log").read_text()
    cases = sorted({owner + "." + name for owner, name in
                    re.findall(r"Test Case '-\[([^\s]+) ([^\]]+)\]' passed", log)})
    row = {"label": label, "compiler_cache_enabled": cached, "seconds": elapsed,
           "returncode": process.returncode, "case_ids": cases,
           "native_cases": len(cases), "build_seconds": re.findall(r"Build complete! \(([\d.]+) sec\)", log),
           "cache_remarks": [line for line in log.splitlines() if "remark:" in line and "cach" in line.lower()],
           "cache_bytes": sum(path.stat().st_size for path in cache.rglob("*") if path.is_file()) if cache.exists() else 0}
    results.append(row)
    (output / "results.json").write_text(json.dumps(results, indent=2) + "\n")
    print(json.dumps({key: value for key, value in row.items() if key not in ("case_ids", "cache_remarks")}))
    if process.returncode:
        print("\n".join(log.splitlines()[-70:]))
        raise SystemExit(process.returncode)
    if len(cases) != 163:
        raise RuntimeError("The full package suite did not execute")
    if any(item["case_ids"] != cases for item in results):
        raise RuntimeError("Package case sets changed between feasibility trials")
subprocess.run(["git", "diff", "--exit-code", "--", "ios/Packages"], check=True)
print("All three complete package suites passed from fresh scratch directories; no performance claim yet.")
