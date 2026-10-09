"""Opt-in deterministic CI sharding after normal pytest collection."""

import argparse
import hashlib
from typing import cast

import pytest

COLLECTED_NODE_IDS = pytest.StashKey[tuple[str, ...]]()


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


@pytest.hookimpl(trylast=True)
def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]) -> None:
    config.stash[COLLECTED_NODE_IDS] = tuple(item.nodeid for item in items)
    shard = cast("tuple[int, int] | None", config.getoption("test_shard"))
    if shard is None:
        return

    index, count = shard
    selected: list[pytest.Item] = []
    deselected: list[pytest.Item] = []
    for item in items:
        # Builtin hash() is process-randomized; both CI workers must agree.
        digest = hashlib.sha256(item.nodeid.encode()).digest()
        assigned = int.from_bytes(digest, "big") % count
        if assigned == index - 1:
            selected.append(item)
        else:
            deselected.append(item)
    items[:] = selected
    config.hook.pytest_deselected(items=deselected)
