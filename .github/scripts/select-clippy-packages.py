#!/usr/bin/env python3
"""Run full Clippy, or preserve workspace feature inputs while pruning PR roots."""

import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tomllib


LIB_KINDS = {"lib", "rlib", "dylib", "cdylib", "staticlib", "proc-macro"}


def full(reason):
    return {"mode": "full", "reason": reason, "changed": [], "selected": []}


def cargo_output(args, workspace):
    return subprocess.check_output(["cargo", *args], cwd=workspace, text=True)


def is_proc_macro(package):
    return any("proc-macro" in target["kind"] for target in package["targets"])


def has_tests(package):
    return any(target["test"] or set(target["kind"]) & {"test", "example", "bench"}
               for target in package["targets"])


def dependency_requests(package, packages, node):
    """Guaranteed root requests, never conditional or optional donations.

    A proc-macro root's test and host contexts differ; retain it but do not use
    its requests as coverage. A valid ambiguous alias similarly cannot donate.
    """
    if is_proc_macro(package):
        return None
    requests = set()
    for dependency in package["dependencies"]:
        if dependency["optional"] or dependency["target"] is not None:
            continue
        kind = dependency["kind"]
        if kind == "build" and not any("custom-build" in t["kind"] for t in package["targets"]):
            continue
        if kind == "dev" and not has_tests(package):
            return None
        alias = (dependency["rename"] or dependency["name"]).replace("-", "_")
        matches = {edge["pkg"] for edge in node["deps"]
                   if edge["name"].replace("-", "_") == alias
                   and packages[edge["pkg"]]["name"] == dependency["name"]
                   and any(item["kind"] == kind and item["target"] is None
                           for item in edge["dep_kinds"])}
        if len(matches) != 1:
            return None
        child = matches.pop()
        if not any(set(target["kind"]) & LIB_KINDS for target in packages[child]["targets"]):
            continue
        context = "host" if kind == "build" or is_proc_macro(packages[child]) else "normal"
        requests.add((child, context, "active"))
        requests.update((child, context, "feature:" + feature) for feature in dependency["features"])
        if dependency["uses_default_features"]:
            requests.add((child, context, "default"))
    return requests


def select(metadata, changed_paths, repository):
    packages = {package["id"]: package for package in metadata["packages"]}
    members = set(metadata["workspace_members"])
    if not members or members != set(metadata["workspace_default_members"]):
        return full("unsupported workspace default members")
    if Path(metadata["workspace_root"]).resolve() != repository / "crates":
        return full("unsupported workspace location")
    nodes = {node["id"]: node for node in metadata["resolve"]["nodes"]}
    roots = {Path(packages[member]["manifest_path"]).resolve().parent: member for member in members}
    if len(roots) != len(members) or any(root == repository / "crates" or not root.is_relative_to(repository / "crates")
                                         for root in roots):
        return full("unsupported package ownership")
    if any(a != b and a.is_relative_to(b) for a in roots for b in roots):
        return full("nested package ownership")
    names = [packages[member]["name"] for member in members]
    if len(set(names)) != len(names):
        return full("ambiguous workspace package names")

    changed = set()
    for value in changed_paths:
        path = repository / value
        owners = [member for root, member in roots.items() if path.is_relative_to(root)]
        if len(owners) != 1:
            return full("unknown or shared changed path: " + value)
        member = owners[0]
        root = Path(packages[member]["manifest_path"]).resolve().parent
        relative = path.relative_to(root)
        if (path.suffix != ".rs" or len(relative.parts) < 2
                or relative.parts[0] not in {"src", "tests", "examples", "benches"}
                or any(parent.is_symlink() for parent in [path, *path.parents] if parent.is_relative_to(repository))):
            return full("non-source or unsupported changed input: " + value)
        changed.add(member)
    if not changed:
        return full("no owned Rust changes")

    reverse = {member: set() for member in members}
    anchors = set()
    requests = {}
    for member in members:
        package = packages[member]
        root = Path(package["manifest_path"]).resolve().parent
        if (package["features"] or is_proc_macro(package)
                or any("custom-build" in t["kind"] for t in package["targets"])
                or any(d["optional"] or d["target"] is not None or d["kind"] == "build"
                       for d in package["dependencies"])
                or any(not Path(t["src_path"]).resolve().is_relative_to(root) for t in package["targets"])
                or any(path.is_symlink() for path in root.rglob("*"))
                # Includes can read another package's source without a Cargo
                # dependency edge. Retain their primary targets conservatively.
                or any(re.search(r"\binclude(?:_str|_bytes)?\b", path.read_text()) for path in root.rglob("*.rs"))):
            anchors.add(member)
        for dependency in package["dependencies"]:
            if dependency.get("path"):
                dependency_root = Path(dependency["path"]).resolve()
                if dependency_root not in roots:
                    return full("path dependency outside workspace ownership")
                reverse[roots[dependency_root]].add(member)
        requests[member] = dependency_requests(package, packages, nodes[member])
        if requests[member] is None:
            anchors.add(member)
            requests[member] = set()

    affected = set(changed)
    pending = list(changed)
    for member in pending:
        for consumer in reverse[member] - affected:
            affected.add(consumer)
            pending.append(consumer)
    selected = affected | anchors
    donors = []
    while True:
        covered = set().union(*(requests[member] for member in selected))
        missing = {member: requests[member] - covered for member in members - selected
                   if not requests[member] <= covered}
        if not missing:
            break
        donor = min(missing, key=lambda member: (-len(missing[member]), packages[member]["name"]))
        selected.add(donor)
        donors.append(packages[donor]["name"])
    if not selected or not selected <= members:
        raise ValueError("invalid Clippy selection")
    ordered = lambda values: sorted(packages[member]["name"] for member in values)
    return {"mode": "selected" if selected != members else "full",
            "reason": "preserved dependency feature requests" if selected != members else "all roots required",
            "changed": ordered(changed), "affected": ordered(affected), "anchors": ordered(anchors),
            "donors": donors, "selected": ordered(selected), "total": len(members)}


def plan(repository, event, base):
    if event != "pull_request":
        return full("full integration checking for " + event)
    if not base:
        return full("unresolved diff base")
    diff = subprocess.run(["git", "diff", "--no-renames", "--name-only", "-z", base, "HEAD", "--"],
                          cwd=repository, stdout=subprocess.PIPE, check=False)
    if diff.returncode:
        return full("unresolved changed-path evidence")
    try:
        changed_paths = diff.stdout.decode("utf-8").rstrip("\0").split("\0") if diff.stdout else []
    except UnicodeDecodeError:
        return full("unsupported changed-path encoding")
    if not changed_paths or any(not value.startswith("crates/") or not value.endswith(".rs")
                                for value in changed_paths):
        return full("shared, non-Rust or empty change set")
    workspace = repository / "crates"
    manifest = tomllib.loads((workspace / "Cargo.toml").read_text())
    if "package" in manifest or manifest["workspace"].get("resolver") != "3":
        return full("unsupported workspace resolver or root package")
    config_path = workspace / ".cargo/config.toml"
    config = tomllib.loads(config_path.read_text()) if config_path.exists() else {}
    if os.environ.get("CARGO_BUILD_TARGET") or config.get("build", {}).get("target"):
        return full("explicit cross-compilation target")
    version = subprocess.check_output(["rustc", "-vV"], text=True)
    host = next(line.removeprefix("host: ") for line in version.splitlines() if line.startswith("host: "))
    metadata = json.loads(cargo_output(["metadata", "--locked", "--all-features", "--format-version", "1",
                                       "--filter-platform", host], workspace))
    return select(metadata, changed_paths, repository)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", type=Path, default=Path.cwd())
    parser.add_argument("--event", required=True)
    parser.add_argument("--base", default="")
    parser.add_argument("--plan-only", action="store_true")
    args = parser.parse_args()
    repository = args.repository.resolve()
    selection = plan(repository, args.event, args.base)
    command = ["cargo", "clippy", "--all-targets", "--all-features"]
    if selection["mode"] == "selected":
        for name in selection["selected"]:
            command.extend(["-p", name])
    selection["command"] = command
    print(json.dumps(selection, sort_keys=True), flush=True)
    if not args.plan_only:
        return subprocess.call(command, cwd=repository / "crates")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, KeyError, TypeError, StopIteration, subprocess.CalledProcessError) as error:
        print("Clippy selection failed: " + str(error), file=sys.stderr)
        sys.exit(2)
