#!/usr/bin/env python3
"""Validate original fixed-restore uncertainty; never convert it to saving proof."""

import guest_preparation_report as preparation
import report

PHASES = preparation.PHASES
LEASE = preparation.LEASE
blob = preparation.blob
wire = preparation.fixed_wire
CONTRACT = preparation.Contract("FixedRestore", wire)
PREFIX = CONTRACT.prefix
CASES = CONTRACT.cases


def validate(directory):
    return preparation.validate(directory, CONTRACT)


if __name__ == "__main__":
    report.run_cli(validate, __doc__, sort_keys=True)
