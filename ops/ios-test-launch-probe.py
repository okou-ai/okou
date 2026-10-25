#!/usr/bin/env python3
"""Compare native test launch metadata with and without a scheme debugger.

Manual CI diagnostic only. Uses the actual build scripts, restores scheme/spec
bytes on failure or cancellation, and never publishes native acceptance proof.
"""

import hashlib
import json
import os
import plistlib
import signal
import subprocess
import xml.etree.ElementTree as ET
from pathlib import Path

active = None


def retire():
    if active is None or active.poll() is not None:
        return
    try:
        os.killpg(active.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    try:
        active.wait(timeout=5)
    except subprocess.TimeoutExpired:
        os.killpg(active.pid, signal.SIGKILL)
        active.wait()


def cancel(signum, _frame):
    raise SystemExit(128 + signum)


def run(phase):
    global active
    active = subprocess.Popen(
        ["bash", "ios/scripts/ci-test.sh", phase], start_new_session=True
    )
    try:
        code = active.wait()
        if code:
            raise SystemExit(code if code > 0 else 128 - code)
    finally:
        retire()
        active = None


def digest(value):
    return hashlib.sha256(value).hexdigest()


def products_digest(root):
    return {
        str(path.relative_to(root)): digest(path.read_bytes())
        for path in sorted((root / "Debug-iphonesimulator").rglob("*"))
        if path.is_file()
    }


def changes(before, after, path=""):
    if before == after:
        return []
    if "EnvironmentVariables" in path:
        return [{"path": path, "values": "redacted"}]
    if isinstance(before, dict) and isinstance(after, dict):
        return [
            item
            for key in sorted(before.keys() | after.keys())
            for item in changes(before.get(key), after.get(key), f"{path}/{key}")
        ]
    if (
        isinstance(before, list)
        and isinstance(after, list)
        and len(before) == len(after)
    ):
        return [
            item
            for index, (a, b) in enumerate(zip(before, after))
            for item in changes(a, b, f"{path}/{index}")
        ]
    if any(word in path.lower() for word in ["debug", "launcher"]):
        return [{"path": path, "before": before, "after": after}]
    return [
        {
            "path": path,
            "before_type": type(before).__name__,
            "after_type": type(after).__name__,
        }
    ]


def main():
    if os.environ.get("GITHUB_EVENT_NAME") != "workflow_dispatch":
        raise SystemExit("Launch metadata inspection requires a manual CI run")
    root = Path(os.environ["RUNNER_TEMP"]) / "okou-ios-ci"
    reports = root / "launch-probe"
    reports.mkdir(mode=0o700, parents=True)
    scheme = Path("ios/Okou.xcodeproj/xcshareddata/xcschemes/Okou.xcscheme")
    original = scheme.read_bytes()
    spec = None
    baseline = None
    report = {
        "source": subprocess.check_output(
            ["git", "rev-parse", "HEAD"], text=True
        ).strip()
    }
    for signum in [signal.SIGTERM, signal.SIGINT]:
        signal.signal(signum, cancel)
    try:
        run("prepare")
        run("compile")
        products = root / "DerivedData/Build/Products"
        specs = list(products.glob("*.xctestrun"))
        if len(specs) != 1:
            raise SystemExit("Expected one native test specification")
        spec = specs[0]
        baseline = spec.read_bytes()
        before_products = products_digest(products)
        tree = ET.fromstring(original)
        actions = tree.findall("TestAction")
        if len(actions) != 1:
            raise SystemExit("Expected one scheme test action")
        report["original_debugger"] = actions[0].get("selectedDebuggerIdentifier")
        report["original_launcher"] = actions[0].get("selectedLauncherIdentifier")
        actions[0].set("selectedDebuggerIdentifier", "")
        actions[0].set(
            "selectedLauncherIdentifier", "Xcode.IDEFoundation.Launcher.PosixSpawn"
        )
        scheme.write_bytes(ET.tostring(tree, encoding="utf-8", xml_declaration=True))
        run("compile")
        variant = spec.read_bytes()
        after_products = products_digest(products)
        report.update(
            baseline_spec_sha256=digest(baseline),
            variant_spec_sha256=digest(variant),
            identical_spec_bytes=baseline == variant,
            metadata_changes=changes(plistlib.loads(baseline), plistlib.loads(variant)),
            changed_product_files=[
                path
                for path in sorted(before_products.keys() | after_products.keys())
                if before_products.get(path) != after_products.get(path)
            ],
            product_file_count=len(before_products),
        )
    finally:
        retire()
        scheme.write_bytes(original)
        if spec is not None and baseline is not None:
            spec.write_bytes(baseline)
        report["scheme_restored"] = scheme.read_bytes() == original
        report["spec_restored"] = (
            spec is not None and baseline is not None and spec.read_bytes() == baseline
        )
        (reports / "metadata.json").write_text(json.dumps(report, indent=2) + "\n")
        print("iOS test launch metadata probe: " + json.dumps(report), flush=True)


if __name__ == "__main__":
    main()
