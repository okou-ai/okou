"""Shared sample freshness and monotonic-window validation."""

import pressure_report as pressure

_READ_FIELDS = {
    "started_ns",
    "finished_ns",
    "read_start_offset_ns",
    "available_bytes",
    "age_ns",
    "read_duration_ns",
}


def _valid_read_window(value, begin, end, *, require_available):
    return (
        isinstance(value, dict)
        and set(value) == _READ_FIELDS
        and all(
            pressure.integer(value[key])
            for key in value
            if require_available or key != "available_bytes"
        )
        and begin < value["started_ns"] < value["finished_ns"] < end
    )


def _duration_fits_window(value):
    return (
        value["read_duration_ns"]
        <= value["age_ns"]
        <= value["finished_ns"] - value["started_ns"]
    )


def sample(value, begin, end, policy):
    if (
        not _valid_read_window(value, begin, end, require_available=False)
        or not _duration_fits_window(value)
        or (
            value["available_bytes"] is not None
            and (
                not pressure.integer(value["available_bytes"])
                or value["available_bytes"] > policy["host_total_bytes"]
            )
        )
    ):
        raise ValueError("logical actual observation timing or availability changed")


def paired_fresh_reads(values, policy, begin, end):
    """Require positive, fresh reads in successive nonoverlapping windows."""
    if not isinstance(values, list) or len(values) < 2:
        raise ValueError("batch ABA lacks original paired fresh reads")
    for value in values:
        if (
            not _valid_read_window(value, begin, end, require_available=True)
            or not 0 < value["available_bytes"] <= policy["host_total_bytes"]
            or not _duration_fits_window(value)
            or value["age_ns"] > policy["max_sample_age_millis"] * 1_000_000
        ):
            raise ValueError(
                "batch ABA observation was fabricated stale or outside resumed admission"
            )
        begin = value["finished_ns"]


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
