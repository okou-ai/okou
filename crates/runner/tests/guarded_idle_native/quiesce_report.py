#!/usr/bin/env python3
"""Strict original Guest dispatcher acknowledgement and retained Dirty custody."""

import guest_preparation_report as preparation
import report


def wire(value, kind, sequence=None, unix_window=None, history=None):
    if kind not in (0x05, 0x06):
        raise ValueError("unexpected quiesce wire authority")
    seq, payload = preparation.original_frame(value, kind, sequence, maximum=9)
    if payload:
        raise ValueError("original quiesce lifecycle payload must be empty")
    return seq


CONTRACT = preparation.Contract("Quiesce", wire)
PREFIX = CONTRACT.prefix
CASES = CONTRACT.cases


def validate(directory):
    return preparation.validate(directory, CONTRACT)


if __name__ == "__main__":
    report.run_cli(validate, __doc__, sort_keys=True)
