"""Validate shared direct create custody evidence in the cancellation reports."""

import observation_report as reads
import pressure_report as pressure
import progress_report as foreground
import report

_CANCEL_WAIT_CLOCKS = (
    "cancelled_ns",
    "first_dropped_ns",
    "second_pending_ns",
    "foreground_acquired_ns",
)


def validate_ordered_clocks(values):
    if any(not report.positive_integer(value) for value in values) or any(
        earlier >= later for earlier, later in zip(values, values[1:])
    ):
        raise ValueError("actual create physical clock order changed")


def _accounting_fields(growth, tracked, *, uncertain):
    return {
        "registered_operations": 1,
        "started": 0 if uncertain else 1,
        "ordinary_growth_bytes": growth,
        "cleanup_growth_bytes": 0,
        "tracked_tasks": tracked,
        "uncertain": int(uncertain),
    }


def validate_accounting(value, growth, *, uncertain=False):
    tracked = value.get("tracked_tasks") if isinstance(value, dict) else None
    if not pressure.integer(tracked, 0 if uncertain else 1) or (uncertain and tracked != 0):
        raise ValueError("actual create tracked custody changed")
    report.exact(
        value,
        _accounting_fields(growth, tracked, uncertain=uncertain),
        "actual create original P2 allowance/uncertainty changed",
    )


def validate_closed_accounting(value, growth, message):
    report.exact(
        value,
        {**_accounting_fields(growth, 0, uncertain=True), "closed": True, "allocated": [0, 0, 0]},
        message,
    )


def validate_accepted_pressure(accepted, begin, end, policy, message):
    samples = accepted.get("samples")
    reads.samples(samples, begin, end, policy)
    fresh = pressure.sustained_ready_samples(samples, end, policy)
    available = accepted.get("available_bytes")
    if not pressure.integer(available, policy["recovery_available_bytes"]) or not any(
        sample["available_bytes"] == available for sample in fresh
    ):
        raise ValueError(message)
    return samples


def validate_cancel_wait(
    waiting, begin, end, growth, generations, *, replay_message, receipt_message
):
    validate_ordered_clocks([begin, *(waiting.get(key) for key in _CANCEL_WAIT_CLOCKS), end])
    validate_accounting(waiting.get("accounting"), growth)
    acquired = waiting["foreground_acquired_ns"]
    foreground.observer(waiting.get("observer"), acquired, end)
    generation = foreground.heartbeat(
        waiting.get("heartbeat"), 1, acquired, end, allocated=(4, 8192)
    )
    if generation in generations:
        raise ValueError(replay_message)
    generations.add(generation)
    report.exact(
        waiting,
        {
            **{key: waiting[key] for key in _CANCEL_WAIT_CLOCKS},
            "accounting": waiting["accounting"],
            "heartbeat": waiting["heartbeat"],
            "observer": waiting["observer"],
            "first_pending": True,
            "first_dropped": True,
            "second_pending": True,
            "release_byte_withheld": True,
            "allocated": [4, 8192, 2],
        },
        receipt_message,
    )
    return generation
