"""Shared sample freshness and monotonic-window validation."""

import pressure_report as pressure


def sample(value, begin, end, policy):
    if (not isinstance(value, dict) or set(value) != {"started_ns", "finished_ns", "read_start_offset_ns",
            "available_bytes", "age_ns", "read_duration_ns"}
            or any(not pressure.integer(value[k]) for k in value if k != "available_bytes")
            or not begin < value["started_ns"] < value["finished_ns"] < end
            or not value["read_duration_ns"] <= value["age_ns"] <= value["finished_ns"]-value["started_ns"]
            or value["available_bytes"] is not None and (
                not pressure.integer(value["available_bytes"]) or value["available_bytes"] > policy["host_total_bytes"])):
        raise ValueError("logical actual observation timing or availability changed")


def samples(values, begin, end, policy):
    if not isinstance(values, list):
        raise ValueError("actual read source samples missing")
    previous = -1
    epoch_lower, epoch_upper = 0, None
    for value in values:
        sample(value, begin, end, policy)
        if value["read_start_offset_ns"] <= previous:
            raise ValueError("actual read observation was replayed")
        previous = value["read_start_offset_ns"]
        # The source epoch is shared. Each actual read start must fit inside
        # its enclosing CLOCK_MONOTONIC interval, including concurrent reads.
        epoch_lower = max(epoch_lower, value["started_ns"]-previous)
        upper = value["finished_ns"]-previous
        epoch_upper = upper if epoch_upper is None else min(epoch_upper, upper)
        if epoch_lower > epoch_upper:
            raise ValueError("actual read offsets contradict their monotonic windows")
