"""Keep the default sandbox suitable for developing the production addon."""

import re
import tomllib
from pathlib import Path

from packaging.specifiers import SpecifierSet

ADDON_ROOT = Path(__file__).resolve().parents[1]
TEMPLATE = ADDON_ROOT.parent / "scripts" / "build-template.sh"


def template_version(name: str) -> str:
    versions = re.findall(rf'^{name}="([0-9]+\.[0-9]+\.[0-9]+)"$', TEMPLATE.read_text(), re.M)
    assert len(versions) == 1, f"template must pin exactly one {name}"
    return versions[0]


def test_sandbox_python_matches_addon_interpreter():
    # The packaged suite independently checks this pin against frozen mitmproxy.
    expected = (ADDON_ROOT / ".python-version").read_text().strip()
    assert template_version("PYTHON_VERSION") == expected
    major, minor, _patch = expected.split(".")
    project = tomllib.loads((ADDON_ROOT / "pyproject.toml").read_text())
    assert expected in SpecifierSet(project["project"]["requires-python"])
    assert project["tool"]["ruff"]["target-version"] == f"py{major}{minor}"
    assert project["tool"]["basedpyright"]["pythonVersion"] == f"{major}.{minor}"


def test_sandbox_uv_matches_addon_requirement():
    project = tomllib.loads((ADDON_ROOT / "pyproject.toml").read_text())
    assert project["tool"]["uv"]["required-version"] == f"=={template_version('UV_VERSION')}"
