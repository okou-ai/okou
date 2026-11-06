"""Keep addon tests and tools aligned with the frozen mitmproxy interpreter."""

import platform
import re
import tomllib
from pathlib import Path

from packaging.specifiers import SpecifierSet

ADDON_ROOT = Path(__file__).resolve().parents[1]
TEMPLATE = ADDON_ROOT.parent / "scripts" / "build-template.sh"


def test_python_runtime_and_tool_targets_match_the_frozen_interpreter_pin():
    # The packaged suite independently checks this pin against frozen mitmproxy.
    expected = (ADDON_ROOT / ".python-version").read_text().strip()
    assert platform.python_version() == expected
    major, minor, _patch = expected.split(".")
    project = tomllib.loads((ADDON_ROOT / "pyproject.toml").read_text())
    assert expected in SpecifierSet(project["project"]["requires-python"])
    assert project["tool"]["ruff"]["target-version"] == f"py{major}{minor}"
    assert project["tool"]["basedpyright"]["pythonVersion"] == f"{major}.{minor}"


def test_sandbox_uv_matches_addon_requirement():
    versions = re.findall(r'^UV_VERSION="([0-9]+\.[0-9]+\.[0-9]+)"$', TEMPLATE.read_text(), re.M)
    assert len(versions) == 1, "template must pin exactly one UV_VERSION"
    project = tomllib.loads((ADDON_ROOT / "pyproject.toml").read_text())
    assert project["tool"]["uv"]["required-version"] == f"=={versions[0]}"
