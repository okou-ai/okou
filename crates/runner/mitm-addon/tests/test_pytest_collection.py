"""Guard fixture discovery and bounded test-runner diagnostics."""

import os
import subprocess
import sys
from pathlib import Path

import pytest

from tests.pytest_sharding import COLLECTED_NODE_IDS


@pytest.mark.parametrize(
    "paths",
    [
        pytest.param(
            (
                "tests/nested/test_first.py",
                "tests/test_middle.py",
                "tests/nested/test_last.py",
            ),
            id="interleaved-files",
        ),
        pytest.param(("tests/",), id="whole-directory"),
    ],
)
def test_directory_fixture_is_available_to_all_consumers(
    tmp_path: Path, paths: tuple[str, ...]
) -> None:
    files = {
        "pytest.ini": "[pytest]\ntestpaths = tests\n",
        "tests/__init__.py": "",
        "tests/nested/__init__.py": "",
        "tests/nested/conftest.py": (
            'import pytest\n\n\n@pytest.fixture\ndef scoped_marker():\n    return "ready"\n'
        ),
        "tests/nested/test_first.py": (
            'def test_first(scoped_marker):\n    assert scoped_marker == "ready"\n'
        ),
        "tests/test_middle.py": "def test_middle():\n    assert True\n",
        "tests/nested/test_last.py": (
            'def test_last(scoped_marker):\n    assert scoped_marker == "ready"\n'
        ),
    }
    for relative_path, content in files.items():
        path = tmp_path / relative_path
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")

    env = os.environ.copy()
    for name in ("PYTEST_ADDOPTS", "PYTEST_PLUGINS", "PYTHONPATH"):
        env.pop(name, None)
    env["PYTEST_DISABLE_PLUGIN_AUTOLOAD"] = "1"

    result = subprocess.run(  # noqa: S603 - Current interpreter and fixture-owned arguments.
        [
            sys.executable,
            "-m",
            "pytest",
            "-c",
            "pytest.ini",
            f"--confcutdir={tmp_path}",
            "-q",
            *paths,
        ],
        cwd=tmp_path,
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )

    assert result.returncode == pytest.ExitCode.OK, result.stdout + result.stderr
    assert "3 passed" in result.stdout, result.stdout + result.stderr


def test_collected_test_node_ids_are_bounded(request: pytest.FixtureRequest) -> None:
    # Large payloads belong in test inputs, not verbose progress or failure summaries.
    oversized = [
        f"{node_id[:160]}... ({len(node_id)} characters)"
        for node_id in request.config.stash[COLLECTED_NODE_IDS]
        if len(node_id) > 1024
    ]
    assert not oversized, "Use short, semantic IDs for large test parameters:\n" + "\n".join(
        oversized
    )
