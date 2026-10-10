"""Opt-in deterministic CI sharding after normal pytest collection."""

import argparse
import hashlib
import math
from typing import cast

import pytest

COLLECTED_NODE_IDS = pytest.StashKey[tuple[str, ...]]()
_DEFAULT_COST = 0.01


def _parse_test_shard(value: str) -> tuple[int, int]:
    message = "must be INDEX/COUNT with 1 <= INDEX <= COUNT"
    try:
        index, count = (int(part) for part in value.split("/"))
    except ValueError as error:
        raise argparse.ArgumentTypeError(message) from error
    if not 1 <= index <= count:
        raise argparse.ArgumentTypeError(message)
    return index, count


def pytest_addoption(parser: pytest.Parser) -> None:
    parser.addoption(
        "--test-shard",
        type=_parse_test_shard,
        default=None,
        metavar="INDEX/COUNT",
        help="Run one deterministic shard after collecting the requested tests (1-based).",
    )


def pytest_configure(config: pytest.Config) -> None:
    config.addinivalue_line(
        "markers", "shard_cost(seconds): estimated cost for balancing expensive CI cases"
    )


def _shard_assignments(items: list[pytest.Item], count: int) -> list[int]:
    loads = [0.0] * count
    assignments: list[int] = []
    expensive: list[tuple[float, str, int]] = []
    for position, item in enumerate(items):
        # Builtin hash() is process-randomized; both CI workers must agree.
        digest = hashlib.sha256(item.nodeid.encode()).digest()
        assigned = int.from_bytes(digest, "big") % count
        assignments.append(assigned)
        marker = item.get_closest_marker("shard_cost")
        if marker is None:
            loads[assigned] += _DEFAULT_COST
            continue
        if (
            len(marker.args) != 1
            or marker.kwargs
            or isinstance(marker.args[0], bool)
            or not isinstance(marker.args[0], int | float)
        ):
            raise pytest.UsageError("shard_cost requires one finite positive number")
        try:
            cost = float(marker.args[0])
        except OverflowError as error:
            raise pytest.UsageError("shard_cost requires one finite positive number") from error
        if not math.isfinite(cost) or cost <= 0:
            raise pytest.UsageError("shard_cost requires one finite positive number")
        expensive.append((cost, item.nodeid, position))
    # Ordinary cases retain their existing assignment. Spread the measured
    # expensive cases over those loads, with deterministic node-ID tie breaking.
    for cost, _node_id, position in sorted(expensive, key=lambda entry: (-entry[0], entry[1])):
        assigned = min(range(count), key=lambda shard: (loads[shard], shard))
        assignments[position] = assigned
        loads[assigned] += cost
    return assignments


@pytest.hookimpl(trylast=True)
def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]) -> None:
    config.stash[COLLECTED_NODE_IDS] = tuple(item.nodeid for item in items)
    shard = cast("tuple[int, int] | None", config.getoption("test_shard"))
    if shard is None:
        return

    index, count = shard
    selected: list[pytest.Item] = []
    deselected: list[pytest.Item] = []
    for item, assigned in zip(items, _shard_assignments(items, count), strict=True):
        if assigned == index - 1:
            selected.append(item)
        else:
            deselected.append(item)
    items[:] = selected
    config.hook.pytest_deselected(items=deselected)
