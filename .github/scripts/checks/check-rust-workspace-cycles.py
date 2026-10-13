#!/usr/bin/env python3
"""Reject cycles in all declared local Cargo workspace dependencies.

Read `cargo metadata --locked --no-deps --format-version 1` from stdin. Use
declarations rather than the feature/platform-filtered resolved graph: Cargo
permits some dev cycles that prevent release-please from generating releases.
"""

import json
import os
from pathlib import Path
import sys


def check(metadata):
    if (metadata["version"] != 1
            or not isinstance(metadata["packages"], list)
            or not isinstance(metadata["workspace_members"], list)
            or not metadata["workspace_members"]):
        raise ValueError("invalid Cargo workspace metadata")

    packages = {package["id"]: package for package in metadata["packages"]}
    member_ids = metadata["workspace_members"]
    if len(packages) != len(metadata["packages"]) or len(set(member_ids)) != len(member_ids):
        raise ValueError("duplicate Cargo package or workspace member IDs")
    members = {member_id: packages[member_id] for member_id in member_ids}
    local_members = {}
    for member_id, package in members.items():
        manifest = Path(package["manifest_path"])
        if not manifest.is_absolute() or not isinstance(package["dependencies"], list):
            raise ValueError("invalid Cargo workspace member metadata")
        identity = (package["name"], manifest.parent.resolve())
        if identity in local_members:
            raise ValueError("duplicate Cargo workspace package identity")
        local_members[identity] = member_id

    graph = {member_id: [] for member_id in members}
    for member_id, package in members.items():
        for dependency in package["dependencies"]:
            # Registry/git declarations and paths outside the workspace are not
            # internal edges, even when they share a workspace package's name.
            if dependency.get("path") is None:
                continue
            dependency_path = Path(dependency["path"])
            if not dependency_path.is_absolute():
                raise ValueError("Cargo dependency paths must be absolute")
            target = local_members.get((dependency["name"], dependency_path.resolve()))
            if target is None:
                continue
            if (dependency["kind"] not in (None, "dev", "build")
                    or not isinstance(dependency["optional"], bool)
                    or not (dependency["target"] is None or isinstance(dependency["target"], str))
                    or not (dependency["rename"] is None or isinstance(dependency["rename"], str))):
                raise ValueError("invalid Cargo workspace dependency metadata")
            graph[member_id].append((target, dependency))

    def order(member_id):
        package = members[member_id]
        return package["name"], package["manifest_path"]

    for edges in graph.values():
        edges.sort(key=lambda edge: (
            order(edge[0]), edge[1]["kind"] or "normal", edge[1]["target"] or "",
            edge[1]["rename"] or "", edge[1]["optional"],
        ))

    visited = set()
    active = {}
    path = []
    path_edges = []
    # An explicit DFS stack also handles long acyclic workspaces without a
    # Python recursion-depth limit. Stop at the first deterministic full cycle.
    for root in sorted(members, key=order):
        if root in visited:
            continue
        active[root] = 0
        path.append(root)
        stack = [iter(graph[root])]
        while stack:
            edge = next(stack[-1], None)
            if edge is None:
                completed = path.pop()
                del active[completed]
                visited.add(completed)
                stack.pop()
                if path_edges:
                    path_edges.pop()
                continue
            target, dependency = edge
            source = path[-1]
            if target in active:
                cycle = path_edges[active[target]:] + [(source, target, dependency)]
                names = [members[cycle[0][0]]["name"]]
                names.extend(members[step[1]]["name"] for step in cycle)
                lines = ["dependency cycle: " + " -> ".join(names)]
                for source_id, target_id, declaration in cycle:
                    context = [(declaration["kind"] or "normal") + "-dependency"]
                    if declaration["target"] is not None:
                        context.append("target=" + declaration["target"])
                    if declaration["optional"]:
                        context.append("optional=true")
                    if declaration["rename"] is not None:
                        context.append("rename=" + declaration["rename"])
                    manifest = os.path.relpath(members[source_id]["manifest_path"])
                    lines.append(
                        f"  {members[source_id]['name']} -> {members[target_id]['name']}: "
                        f"{', '.join(context)} ({manifest})"
                    )
                raise ValueError("\n".join(lines))
            if target not in visited:
                active[target] = len(path)
                path.append(target)
                path_edges.append((source, target, dependency))
                stack.append(iter(graph[target]))

    edge_count = sum(len(edges) for edges in graph.values())
    print(f"rust workspace cycles: ok ({len(members)} crates, {edge_count} dependencies)")


if __name__ == "__main__":
    try:
        check(json.load(sys.stdin))
    except (KeyError, TypeError, AttributeError, OSError, ValueError) as error:
        print("rust workspace cycles: " + str(error), file=sys.stderr)
        sys.exit(1)
