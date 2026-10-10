"""Exercise opt-in sharding through isolated, real pytest invocations."""

import inspect
import json
import os
import subprocess
import sys
from collections import Counter
from pathlib import Path

import pytest

from tests.test_pytest_collection import (
    test_collected_test_node_ids_are_bounded as assert_node_ids_bounded,
)


@pytest.fixture
def suite(tmp_path: Path) -> Path:
    files = {
        "pytest.ini": "[pytest]\ntestpaths = tests\n",
        "tests/__init__.py": "",
        "tests/nested/__init__.py": "",
        "tests/pytest_sharding.py": Path(__file__).with_name("pytest_sharding.py").read_text(),
        "tests/conftest.py": (
            "import json\nfrom pathlib import Path\nimport pytest\n"
            'pytest.register_assert_rewrite("tests.pytest_sharding")\n'
            "from tests.pytest_sharding import COLLECTED_NODE_IDS\n"
            'pytest_plugins = ["tests.pytest_sharding"]\n'
            "def pytest_sessionfinish(session, exitstatus):\n"
            '    Path("nodeids.json").write_text(json.dumps({\n'
            '        "collected": session.config.stash.get(COLLECTED_NODE_IDS, ()),\n'
            '        "selected": [item.nodeid for item in session.items],\n'
            "    }))\n"
        ),
        "tests/nested/conftest.py": (
            'import pytest\n@pytest.fixture\ndef scoped_marker():\n    return "ready"\n'
        ),
        "tests/nested/test_first.py": (
            'import pytest\n@pytest.mark.parametrize("value", range(6))\n'
            "def test_first(scoped_marker, value):\n"
            '    assert scoped_marker == "ready"\n'
        ),
        "tests/test_middle.py": "def test_middle():\n    assert True\n",
        "tests/nested/test_last.py": (
            'import pytest\n@pytest.mark.parametrize("value", range(7))\n'
            "def test_last(scoped_marker, value):\n"
            '    assert scoped_marker == "ready"\n'
        ),
        "tests/test_collection.py": (
            "import pytest\nfrom tests.pytest_sharding import COLLECTED_NODE_IDS\n\n"
            + inspect.getsource(assert_node_ids_bounded)
        ),
    }
    for relative, content in files.items():
        path = tmp_path / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
    return tmp_path


def _run_suite(
    suite: Path,
    arguments: tuple[str, ...] = (),
    *,
    paths: tuple[str, ...] = ("tests/",),
    hash_seed: str = "1",
) -> tuple[subprocess.CompletedProcess[str], dict[str, list[str]]]:
    report_path = suite / "nodeids.json"
    report_path.unlink(missing_ok=True)
    env = os.environ.copy()
    for name in ("PYTEST_ADDOPTS", "PYTEST_PLUGINS", "PYTHONPATH"):
        env.pop(name, None)
    env["PYTEST_DISABLE_PLUGIN_AUTOLOAD"] = "1"
    env["PYTHONHASHSEED"] = hash_seed
    result = subprocess.run(  # noqa: S603 - Current interpreter and fixture-owned arguments.
        [
            sys.executable,
            "-m",
            "pytest",
            "-c",
            "pytest.ini",
            f"--confcutdir={suite}",
            "-q",
            *arguments,
            *paths,
        ],
        cwd=suite,
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    report: dict[str, list[str]] = (
        json.loads(report_path.read_text()) if report_path.exists() else {}
    )
    return result, report


def test_shards_are_complete_disjoint_and_stable(suite: Path) -> None:
    full, all_nodes = _run_suite(suite)
    first, first_nodes = _run_suite(suite, ("--test-shard=1/2",))
    second, second_nodes = _run_suite(suite, ("--test-shard=2/2",), hash_seed="42")
    repeated, repeated_nodes = _run_suite(suite, ("--test-shard=1/2",), hash_seed="123")
    for result in (full, first, second, repeated):
        assert result.returncode == pytest.ExitCode.OK, result.stdout + result.stderr

    assert len(all_nodes["selected"]) == 15
    assert all_nodes["selected"] == all_nodes["collected"]
    assert first_nodes["collected"] == second_nodes["collected"] == all_nodes["collected"]
    assert first_nodes["selected"]
    assert second_nodes["selected"]
    assert set(first_nodes["selected"]).isdisjoint(second_nodes["selected"])
    assert Counter(first_nodes["selected"] + second_nodes["selected"]) == Counter(
        all_nodes["selected"]
    )
    assert repeated_nodes == first_nodes
    for report in (first_nodes, second_nodes):
        assert report["selected"] == [
            node for node in all_nodes["selected"] if node in report["selected"]
        ]


@pytest.mark.shard_cost(1)
def test_costly_cases_are_balanced_without_losing_order_or_coverage(suite: Path) -> None:
    # These two cases previously shared the same hash partition. Each is much
    # more expensive than the rest of this fixture-owned suite combined.
    costly = ["tests/test_costs.py::test_expensive0", "tests/test_costs.py::test_expensive2"]
    (suite / "tests/test_costs.py").write_text(
        "import pytest\n"
        "@pytest.mark.shard_cost(10)\ndef test_expensive0():\n    assert True\n"
        "@pytest.mark.shard_cost(10)\ndef test_expensive2():\n    assert True\n"
    )
    full, all_nodes = _run_suite(suite)
    first, first_nodes = _run_suite(suite, ("--test-shard=1/2",))
    second, second_nodes = _run_suite(suite, ("--test-shard=2/2",), hash_seed="42")
    repeated, repeated_nodes = _run_suite(suite, ("--test-shard=1/2",), hash_seed="123")
    for result in (full, first, second, repeated):
        assert result.returncode == pytest.ExitCode.OK, result.stdout + result.stderr
    assert all_nodes["selected"] == all_nodes["collected"]
    assert first_nodes["collected"] == second_nodes["collected"] == all_nodes["collected"]
    assert set(first_nodes["selected"]).isdisjoint(second_nodes["selected"])
    assert Counter(first_nodes["selected"] + second_nodes["selected"]) == Counter(
        all_nodes["selected"]
    )
    assert repeated_nodes == first_nodes
    for report in (first_nodes, second_nodes):
        assert sum(node in report["selected"] for node in costly) == 1
        assert report["selected"] == [
            node for node in all_nodes["selected"] if node in report["selected"]
        ]


@pytest.mark.parametrize(
    "arguments",
    [
        "",
        "0",
        "-1",
        "True",
        "'slow'",
        "float('nan')",
        "float('inf')",
        "10**1000",
        "1, 2",
        "seconds=1",
    ],
    ids=[
        "missing",
        "zero",
        "negative",
        "boolean",
        "string",
        "nan",
        "infinite",
        "overflow",
        "extra",
        "keyword",
    ],
)
def test_invalid_shard_cost_fails_before_execution(suite: Path, arguments: str) -> None:
    (suite / "tests/test_costs.py").write_text(
        "import pytest\n"
        f"@pytest.mark.shard_cost({arguments})\n"
        "def test_invalid_cost():\n    pytest.fail('invalid cost was executed')\n"
    )
    result, _report = _run_suite(suite, ("--test-shard=1/2",))
    assert result.returncode == pytest.ExitCode.USAGE_ERROR
    assert "shard_cost requires one finite positive number" in result.stderr
    assert "invalid cost was executed" not in result.stdout


@pytest.mark.parametrize(
    "paths",
    [
        ("tests/nested/test_first.py", "tests/test_middle.py", "tests/nested/test_last.py"),
        ("tests/",),
    ],
    ids=["interleaved-files", "whole-directory"],
)
def test_single_shard_preserves_directory_fixtures(suite: Path, paths: tuple[str, ...]) -> None:
    result, report = _run_suite(suite, ("--test-shard=1/1",), paths=paths)
    assert result.returncode == pytest.ExitCode.OK, result.stdout + result.stderr
    assert report["selected"] == report["collected"]
    assert len(report["selected"]) == (14 if len(paths) == 3 else 15)


def test_shard_preserves_keyword_selection(suite: Path) -> None:
    result, report = _run_suite(suite, ("--test-shard=1/1", "-k", "test_first"))
    assert result.returncode == pytest.ExitCode.OK, result.stdout + result.stderr
    assert len(report["selected"]) == 6
    assert report["collected"] == report["selected"]


@pytest.mark.parametrize("value", ["0/2", "3/2", "1/0", "-1/2", "1/x", "2", "1/2/3", ""])
def test_invalid_shard_selector_fails_before_execution(suite: Path, value: str) -> None:
    result, report = _run_suite(suite, (f"--test-shard={value}",))
    assert result.returncode == pytest.ExitCode.USAGE_ERROR
    assert "must be INDEX/COUNT with 1 <= INDEX <= COUNT" in result.stderr
    assert not report


def test_empty_shard_does_not_pass(suite: Path) -> None:
    results = [
        _run_suite(suite, (f"--test-shard={index}/2",), paths=("tests/test_middle.py",))
        for index in (1, 2)
    ]
    assert sorted(result.returncode for result, _ in results) == [
        pytest.ExitCode.OK,
        pytest.ExitCode.NO_TESTS_COLLECTED,
    ]
    assert sum(len(report["selected"]) for _, report in results) == 1


def test_failing_shard_preserves_pytest_failure(suite: Path) -> None:
    (suite / "tests/test_failure.py").write_text("def test_failure():\n    assert False\n")
    results = [_run_suite(suite, (f"--test-shard={index}/2",)) for index in (1, 2)]
    assert sorted(result.returncode for result, _ in results) == [
        pytest.ExitCode.OK,
        pytest.ExitCode.TESTS_FAILED,
    ]
    for result, report in results:
        if "tests/test_failure.py::test_failure" in report["selected"]:
            assert result.returncode == pytest.ExitCode.TESTS_FAILED


def test_node_id_guard_covers_deselected_cases(suite: Path) -> None:
    ids = ["x" * 1100 + str(index) for index in range(16)]
    (suite / "tests/test_payload.py").write_text(
        "import pytest\n"
        f'@pytest.mark.parametrize("value", range(16), ids={ids!r})\n'
        "def test_payload(value):\n    assert True\n"
    )
    guard = "tests/test_collection.py::test_collected_test_node_ids_are_bounded"
    for index in (1, 2):
        selector = (f"--test-shard={index}/2",)
        collected, report = _run_suite(suite, (*selector, "--collect-only"))
        assert collected.returncode == pytest.ExitCode.OK, collected.stdout + collected.stderr
        if guard not in report["selected"]:
            continue
        deselected_ids = [
            node_id
            for node_id in ids
            if f"tests/test_payload.py::test_payload[{node_id}]" not in report["selected"]
        ]
        assert deselected_ids
        lone_id = deselected_ids[0]
        (suite / "tests/test_payload.py").write_text(
            "import pytest\n"
            f'@pytest.mark.parametrize("value", [0], ids={[lone_id]!r})\n'
            "def test_payload(value):\n    assert True\n"
        )
        result, final_report = _run_suite(suite, selector)
        assert all(len(node) <= 1024 for node in final_report["selected"])
        assert [node for node in final_report["collected"] if len(node) > 1024] == [
            f"tests/test_payload.py::test_payload[{lone_id}]"
        ]
        assert result.returncode == pytest.ExitCode.TESTS_FAILED
        assert "Use short, semantic IDs for large test parameters" in result.stdout
        return
    pytest.fail("node-ID guard was not assigned to any shard")
