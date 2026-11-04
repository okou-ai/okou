"""Compare the released runtime's dependency closure, not its development tools."""

import tomllib
from pathlib import Path

from packaging.markers import Marker
from packaging.utils import canonicalize_name


def runtime_lock_versions(path: Path, mitmproxy_version: str) -> dict[str, str]:
    lock = tomllib.loads(path.read_text(encoding="utf-8"))
    packages: dict[str, list[dict[str, object]]] = {}
    for package in lock["package"]:
        packages.setdefault(canonicalize_name(package["name"]), []).append(package)
    versions: dict[str, str] = {}
    pending = ["mitmproxy"]
    while pending:
        name = pending.pop()
        if name in versions:
            continue
        candidates = packages[name]
        assert len(candidates) == 1, f"Ambiguous runtime dependency: {name}"
        package = candidates[0]
        version = package.get("version")
        # The upstream editable root obtains its release version dynamically.
        if name == "mitmproxy" and version is None:
            version = mitmproxy_version
        assert isinstance(version, str), f"Missing runtime dependency version: {name}"
        versions[name] = version
        dependencies = package.get("dependencies", [])
        assert isinstance(dependencies, list)
        for dependency in dependencies:
            marker = dependency.get("marker")
            if marker is None or Marker(marker).evaluate():
                pending.append(canonicalize_name(dependency["name"]))
    return versions
