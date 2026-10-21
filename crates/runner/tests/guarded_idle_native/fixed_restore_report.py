#!/usr/bin/env python3
"""Validate original fixed-restore uncertainty; never convert it to saving proof."""
import argparse
import json
import pathlib

import guest_preparation_report as preparation

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
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=pathlib.Path)
    print(json.dumps(validate(parser.parse_args().directory), indent=2, sort_keys=True))
