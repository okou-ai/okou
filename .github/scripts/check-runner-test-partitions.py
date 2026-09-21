#!/usr/bin/env python3
"""Validate Runner test target ownership and, optionally, exact test names."""

from __future__ import annotations

import argparse
from collections import Counter
import json
from pathlib import Path
import re
import subprocess
import sys
import tomllib


ROOT = Path(__file__).resolve().parents[2]
RUNNER = ROOT / "crates/runner"
MANIFEST = RUNNER / "Cargo.toml"
SNAPSHOT = RUNNER / "test_targets/test_names.txt"
TARGETS = {
    "runner-cmd-start": ("cmd_start.rs", "cmd_start"),
    "runner-cmd-service": ("cmd_service.rs", "cmd_service"),
    "runner-cmd-gc-build": ("cmd_gc_build.rs", "cmd_gc_build"),
    "runner-cmd-other": ("cmd_other.rs", "cmd_other"),
    "runner-executor": ("executor.rs", "executor"),
    "runner-provider": ("provider.rs", "provider"),
    "runner-storage": ("storage.rs", "storage"),
    "runner-network": ("network.rs", "network"),
    "runner-runtime-control": ("runtime_control.rs", "runtime_control"),
    "runner-platform-support": ("platform_support.rs", "platform_support"),
}
GROUPS = {group for _, group in TARGETS.values()}
SHARED_MODULES = {
    ("cmd/gc/mod.rs", "test_support"),
    ("cmd/kill.rs", "test_support"),
    ("cmd/local/input.rs", "input_test_support"),
    ("cmd/local/submit.rs", "submit_test_support"),
    ("host_file.rs", "atomic_write_test"),
    ("idle_pool.rs", "test_support"),
    ("process/discovery.rs", "test_support"),
    ("provider/api_ably_supervisor.rs", "testing"),
    ("provider/mod.rs", "mock"),
    ("runner.rs", "test_fixtures"),
    ("workspace_promotion.rs", "test_support"),
}
MODULE = re.compile(
    r"#\[cfg\([^\]]*\btest\b[^\]]*\)\]\s*"
    r"(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_][A-Za-z0-9_]*)"
)
OWNED_MODULE = re.compile(
    r"runner_test_(group|support)!\(\s*([^;]+?)\s*;\s*"
    r"#\[cfg\([^\]]*\btest\b[^\]]*\)\]\s*"
    r"(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_][A-Za-z0-9_]*)"
)
SELECTOR = re.compile(r"runner_test_(?:group|support)!\(\s*([^;]+?)\s*;")


def fail(message: str) -> None:
    raise SystemExit(f"runner test partition check: {message}")


def source_location(path: Path, text: str, offset: int) -> str:
    return f"{path.relative_to(ROOT)}:{text.count(chr(10), 0, offset) + 1}"


def validate_manifest_and_wrappers() -> None:
    manifest = tomllib.loads(MANIFEST.read_text())
    binary = next((item for item in manifest.get("bin", []) if item.get("name") == "runner"), None)
    if binary != {"name": "runner", "path": "src/main.rs", "test": False}:
        fail("the runner binary must keep src/main.rs with test = false")

    actual = {
        item["name"]: Path(item["path"]).name
        for item in manifest.get("test", [])
        if item.get("name", "").startswith("runner-")
    }
    expected = {name: filename for name, (filename, _) in TARGETS.items()}
    if actual != expected:
        fail(f"Cargo target registry drifted: expected {expected}, got {actual}")

    for name, (filename, group) in TARGETS.items():
        path = RUNNER / "test_targets" / filename
        text = path.read_text()
        if f"({group} $(, $rest:ident)*; $item:item)" not in text:
            fail(f"{name} does not select its ownership group")
        if f"({group}; $item:item)" not in text:
            fail(f"{name} does not select its support owner")
        if text.count('include!("../src/runner.rs");') != 1:
            fail(f"{name} must include the shared Runner root exactly once")


def validate_source_ownership() -> None:
    shared = set()
    module_count = 0
    for path in sorted((RUNNER / "src").rglob("*.rs")):
        text = path.read_text()
        relative = path.relative_to(RUNNER / "src").as_posix()
        owned = {(match.start(3), match.group(3)) for match in OWNED_MODULE.finditer(text)}
        for match in MODULE.finditer(text):
            module_count += 1
            key = (match.start(1), match.group(1))
            if key not in owned:
                fail(f"unowned cfg(test) module at {source_location(path, text, match.start())}")

        for match in OWNED_MODULE.finditer(text):
            kind, owners, module = match.groups()
            names = [owner.strip() for owner in owners.split(",")]
            invalid = set(names) - GROUPS - {"shared"}
            if invalid:
                fail(
                    f"invalid group {sorted(invalid)} at "
                    f"{source_location(path, text, match.start())}"
                )
            if kind == "support":
                if names != ["shared"]:
                    fail(
                        f"shared module must use only the shared support owner at "
                        f"{source_location(path, text, match.start())}"
                    )
                shared.add((relative, module))
            elif "shared" in names:
                fail(f"shared is reserved for support modules in {relative}")

        for match in SELECTOR.finditer(text):
            invalid = {
                owner.strip()
                for owner in match.group(1).split(",")
                if owner.strip() not in GROUPS | {"shared"}
            }
            if invalid:
                fail(
                    f"invalid selector group {sorted(invalid)} at "
                    f"{source_location(path, text, match.start())}"
                )

    if shared != SHARED_MODULES:
        fail(
            "shared support allowlist drifted: "
            f"missing={sorted(SHARED_MODULES - shared)}, extra={sorted(shared - SHARED_MODULES)}"
        )
    if module_count == 0:
        fail("no cfg(test) modules found")


def load_snapshot() -> list[str]:
    if not SNAPSHOT.is_file():
        fail(f"missing exact-name snapshot {SNAPSHOT.relative_to(ROOT)}")
    names = SNAPSHOT.read_text().splitlines()
    if names != sorted(names):
        fail("exact-name snapshot is not sorted")
    if len(names) != 3_999 or len(set(names)) != len(names):
        fail("exact-name snapshot must contain 3,999 unique names")
    return names


def compile_and_list() -> list[str]:
    command = [
        "cargo",
        "test",
        "--manifest-path",
        str(ROOT / "crates/Cargo.toml"),
        "--profile",
        "local",
        "--locked",
        "-j",
        "1",
        "-p",
        "runner",
        "--tests",
        "--no-run",
        "--message-format=json-render-diagnostics",
    ]
    process = subprocess.Popen(command, cwd=ROOT, stdout=subprocess.PIPE, text=True)
    assert process.stdout is not None
    executables: dict[str, Path] = {}
    for line in process.stdout:
        try:
            message = json.loads(line)
        except json.JSONDecodeError:
            continue
        target = message.get("target", {})
        name = target.get("name")
        executable = message.get("executable")
        if (
            message.get("reason") == "compiler-artifact"
            and name in TARGETS
            and message.get("profile", {}).get("test") is True
            and target.get("kind") == ["test"]
            and executable
        ):
            if name in executables:
                fail(f"Cargo emitted {name} more than once")
            executables[name] = Path(executable)
    if process.wait() != 0:
        fail("serialized Runner test compilation failed")
    if set(executables) != set(TARGETS):
        fail(f"missing test executables: {sorted(set(TARGETS) - set(executables))}")

    names = []
    for target in TARGETS:
        result = subprocess.run(
            [str(executables[target]), "--list", "--format", "terse"],
            cwd=ROOT,
            check=True,
            capture_output=True,
            text=True,
        )
        target_names = [
            line.removesuffix(": test")
            for line in result.stdout.splitlines()
            if line.endswith(": test")
        ]
        names.extend(target_names)
    duplicates = sorted(name for name, count in Counter(names).items() if count > 1)
    if duplicates:
        fail(f"tests emitted by more than one target: {duplicates[:10]}")
    return sorted(names)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--list",
        action="store_true",
        help="compile the ten targets with -j 1 and compare their test names",
    )
    args = parser.parse_args()
    validate_manifest_and_wrappers()
    validate_source_ownership()
    expected = load_snapshot()
    if args.list:
        actual = compile_and_list()
        if actual != expected:
            missing = sorted(set(expected) - set(actual))
            extra = sorted(set(actual) - set(expected))
            fail(
                f"exact test names drifted: count={len(actual)}, "
                f"missing={missing[:10]}, extra={extra[:10]}"
            )
    print("runner test partition check: ok")


if __name__ == "__main__":
    main()
