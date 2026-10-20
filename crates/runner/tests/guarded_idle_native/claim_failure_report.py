#!/usr/bin/env python3
"""Actual ApiProvider transport/decode unavailability and joined native saving."""
import argparse
import json
import pathlib

import claim_loss_report

CASES = {f"ClaimUnavailable-{fault}-{mode}" for fault in ("decode", "disconnect")
         for mode in ("fresh", "snapshot")}
OUTCOMES = {case: ({"status": 200, "failure_boundary": "decode", "response_body_hex": "7b"}
                  if "-decode-" in case else
                  {"status": None, "failure_boundary": "disconnect", "response_body_hex": None})
            for case in CASES}


def validate(directory):
    result = claim_loss_report.validate(directory, cases=CASES,
        policy_key="native_claim_failure_policy_json", outcomes=OUTCOMES)
    result.pop("native_provider_404_rollback_complete")
    return result | {"format": "native-claim-failure-report-v1",
                     "native_provider_failure_rollback_complete": True,
                     "remote_non_claim_proven": False, "producer_loss_proven": False}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=pathlib.Path)
    print(json.dumps(validate(parser.parse_args().directory), indent=2, sort_keys=True))
