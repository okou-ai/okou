"""Qualify SwiftPM object reuse without retaining executable tests or results."""

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
build = temporary / "okou-ios-ci"
results = []
for label, cached in (("baseline", False), ("object-replay", True)):
    removed = []
    for package in ("ChatDomain", "ChatData"):
        scratch = build / package
        if not cached:
            if scratch.exists():
                raise RuntimeError("The baseline must start without package build outputs")
            continue
        for product in sorted(scratch.rglob("*"), key=lambda path: len(path.parts), reverse=True):
            if product.suffix in (".xctest", ".xcresult") and product.exists():
                removed.append(str(product.relative_to(build)))
                if product.is_dir():
                    shutil.rmtree(product)
                else:
                    product.unlink()
    if cached and len([path for path in removed if path.endswith(".xctest")]) != 2:
        raise RuntimeError("Expected both executable test bundles to be removed before replay")
    env = os.environ.copy()
    env.pop("IOS_PACKAGE_COMPILATION_CACHE_PATH", None)
    started = time.monotonic()
    with (output / f"{label}.log").open("wb") as stream:
        process = subprocess.run(["bash", "ios/scripts/ci-package-test.sh"],
                                 env=env, stdout=stream, stderr=subprocess.STDOUT)
    elapsed = time.monotonic() - started
    log = (output / f"{label}.log").read_text()
    cases = sorted({owner + "." + name for owner, name in
                    re.findall(r"Test Case '-\[([^\s]+) ([^\]]+)\]' passed", log)})
    row = {"label": label, "object_replay": cached, "seconds": elapsed,
           "returncode": process.returncode, "case_ids": cases,
           "native_cases": len(cases), "build_seconds": re.findall(r"Build complete! \(([\d.]+) sec\)", log),
           "removed_test_products": removed,
           "build_bytes": sum(path.stat().st_size for path in build.rglob("*") if path.is_file())}
    results.append(row)
    (output / "results.json").write_text(json.dumps(results, indent=2) + "\n")
    print(json.dumps({key: value for key, value in row.items() if key != "case_ids"}))
    if process.returncode:
        print("\n".join(log.splitlines()[-70:]))
        raise SystemExit(process.returncode)
    if len(cases) != 163:
        raise RuntimeError("The full package suite did not execute")
    if any(item["case_ids"] != cases for item in results):
        raise RuntimeError("Package case sets changed between feasibility trials")
subprocess.run(["git", "diff", "--exit-code", "--", "ios/Packages"], check=True)
print("Both complete suites passed, with fresh executable test bundles; same-host timing is diagnostic only.")
