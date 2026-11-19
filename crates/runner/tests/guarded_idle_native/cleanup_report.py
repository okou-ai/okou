#!/usr/bin/env python3
"""Shared custody and supplied-policy checks for native required-saving proofs."""

import pressure_report as pressure
import report
from report import exact

COUNTS = {"registered_operations", "queued", "granted", "started", "uncertain",
          "ordinary_growth_bytes", "cleanup_growth_bytes", "tracked_tasks"}


def accounting(value, closed, policy=None):
    if (not isinstance(value, dict) or set(value) != COUNTS | {"closed"}
            or value["closed"] is not closed
            or any(not pressure.integer(value[k]) for k in COUNTS)):
        raise ValueError("cleanup accounting shape or types changed")
    if policy is None:
        exact(value, dict.fromkeys(COUNTS, 0) | {"closed": True},
              "cleanup accounting did not positively settle")
    elif (any(value[k] != 0 for k in ("queued", "granted", "uncertain", "ordinary_growth_bytes"))
          or any(value[k] == 0 for k in ("registered_operations", "started", "tracked_tasks"))
          or not policy["tail_growth_bytes"] <= value["cleanup_growth_bytes"]
          <= policy["tail_growth_bytes"] + policy["live_growth_bytes"]):
        raise ValueError("cleanup prematurely released accepted physical custody")


def coverage(value, policy, closed):
    if not isinstance(value, dict) or "accounting" not in value:
        raise ValueError("cleanup has no original coverage")
    accounting(value["accounting"], closed, policy)
    exact(value, {"allocated": [2, 4096, 1], "accounting": value["accounting"],
                  "original_lease_active": True, "io_release_withheld": True},
          "cleanup released its original full lease or IO gate")


def supplied_policy(collector, result, key):
    raw = collector["metadata"][key]
    policy = report.decode_original_policy(
        raw, result["artifacts"], "cleanup original policy identity changed")
    if (not pressure.has_policy_shape(policy)
            or policy["operating_floor_bytes"] + policy["cleanup_reserve_bytes"] >= policy["host_total_bytes"]
            or not policy["operating_floor_bytes"] <= policy["critical_available_bytes"]
            < policy["recovery_available_bytes"] <= policy["host_total_bytes"]
            or policy["tail_growth_bytes"] < 65 * 1024**2 or policy["max_cleanup_inflight"] < 2):
        raise ValueError("invalid cleanup supplied policy")
    return policy
