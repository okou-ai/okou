"""Measure isolated SwiftPM object snapshots while retaining complete test execution."""

import hashlib
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import time

temporary = pathlib.Path(os.environ["RUNNER_TEMP"])
output = temporary / "package-object-trial"
build = temporary / "okou-ios-ci"
mode = os.environ["PACKAGE_CACHE_TRIAL_MODE"]
label = os.environ["PACKAGE_CACHE_TRIAL_LABEL"]


def command(*args):
    return subprocess.check_output(args, text=True).strip()


def write(name, data):
    (output / name).write_text(json.dumps(data, indent=2) + "\n")


def identity():
    roots = ["ios/Packages/ChatDomain", "ios/Packages/ChatData", "ios/scripts/ci-package-test.sh"]
    if command("git", "status", "--porcelain", "--untracked-files=all", "--", *roots):
        raise RuntimeError("Package build inputs must match the frozen checkout")
    files = command("git", "ls-tree", "-r", "HEAD", "--", *roots)
    return {
        "input_sha256": hashlib.sha256(files.encode()).hexdigest(),
        "swift": command("xcrun", "swift", "--version"),
        "xcode": command("xcodebuild", "-version"),
        "macos_sdk_build": command("xcrun", "--sdk", "macosx", "--show-sdk-build-version"),
        "macos_build": command("sw_vers", "-buildVersion"),
        "architecture": command("uname", "-m"),
        "workspace": str(pathlib.Path.cwd()),
        "scratch_root": str(build),
    }


def retained_test_products():
    return [str(path.relative_to(build)) for package in ("ChatDomain", "ChatData")
            for path in (build / package).rglob("*")
            if path.suffix in (".xctest", ".xcresult")]


operation = sys.argv[1]
if operation == "start":
    if mode not in ("seed", "baseline", "warm"):
        raise ValueError(mode)
    output.mkdir()
    if any((build / package).exists() for package in ("ChatDomain", "ChatData")):
        raise RuntimeError("Each trial needs a fresh runner and empty initial scratch roots")
    started = time.monotonic()
    inputs = identity()
    write("start.json", {"label": label, "mode": mode, "started": started,
                         "identity": inputs, "source": command("git", "rev-parse", "HEAD")})
elif operation == "validate":
    if os.environ.get("PACKAGE_CACHE_EXACT_HIT") != "true":
        raise RuntimeError("Warm trials require an exact real cache hit")
    start = json.loads((output / "start.json").read_text())
    cached = json.loads((build / "package-cache-identity.json").read_text())
    if cached != start["identity"] or cached != identity():
        raise RuntimeError("Cached source/toolchain/SDK/architecture/path identity differs")
    products = retained_test_products()
    if products:
        raise RuntimeError("Executable test products or results were restored: " + repr(products))
    write("cache-validation.json", {"exact_hit": True, "identity_verified": True,
                                    "restored_test_products": products})
elif operation == "snapshot":
    start = json.loads((output / "start.json").read_text())
    removed = retained_test_products()
    for name in sorted(removed, key=lambda item: len(pathlib.Path(item).parts), reverse=True):
        path = build / name
        if path.is_symlink() or path.is_file():
            path.unlink()
        elif path.exists():
            shutil.rmtree(path)
    if len([name for name in removed if name.endswith(".xctest")]) != 2 or retained_test_products():
        raise RuntimeError("Expected both executable test bundles to be removed")
    if identity() != start["identity"]:
        raise RuntimeError("Inputs changed while producing the snapshot")
    (build / "package-cache-identity.json").write_text(json.dumps(start["identity"], indent=2) + "\n")
    write("snapshot.json", {"removed_test_products": removed,
                            "bytes": sum(path.stat().st_size for package in ("ChatDomain", "ChatData")
                                         for path in (build / package).rglob("*") if path.is_file())})
elif operation == "report":
    start = json.loads((output / "start.json").read_text())
    log = (output / "build.log").read_text()
    cases = sorted({owner + "." + name for owner, name in
                    re.findall(r"Test Case '-\[([^\s]+) ([^\]]+)\]' passed", log)})
    failures = re.findall(r"Test Case '-\[([^\s]+) ([^\]]+)\]' failed", log)
    if len(cases) != 163 or failures or identity() != start["identity"]:
        raise RuntimeError("The complete unchanged package suite must pass")
    write("summary.json", {"label": label, "mode": mode, "source": start["source"],
                           "restore_build_test_seconds": time.monotonic() - start["started"],
                           "case_ids": cases, "native_cases": len(cases), "failures": failures,
                           "build_seconds": re.findall(r"Build complete! \(([\d.]+) sec\)", log),
                           "identity": start["identity"]})
else:
    raise ValueError(operation)
