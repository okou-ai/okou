#!/usr/bin/env python3

import argparse
import json
import sys
from pathlib import Path


def load_json(path):
    with Path(path).open() as source:
        return json.load(source)


def count_findings(results):
    counts = {}
    for result in results.get("results", []):
        rule_id = result["check_id"]
        counts[rule_id] = counts.get(rule_id, 0) + 1
    return counts


def check_findings(mode, baseline_path, results_path):
    baseline = load_json(baseline_path)
    current = count_findings(load_json(results_path))

    errors = []
    for rule_id, count in sorted(current.items()):
        allowed = baseline.get(rule_id, 0) if mode == "full" else 0
        if count <= allowed:
            continue

        if mode == "diff" or allowed == 0:
            errors.append(f"NEW rule {rule_id}: {count} finding(s)")
        else:
            errors.append(
                f"REGRESSION {rule_id}: {count} (baseline: {allowed})"
            )

    print(f"Semgrep: {len(current)} rules, {sum(current.values())} total findings")
    for rule_id, count in sorted(current.items()):
        allowed = baseline.get(rule_id, 0) if mode == "full" else 0
        status = "OK" if count <= allowed else "FAIL"
        print(f"  [{status}] {rule_id}: {count} (allowed: {allowed})")

    if errors:
        print(f"\n{len(errors)} regression(s) found:")
        for error in errors:
            print(f"  - {error}")
        return 1

    if mode == "diff":
        print("\nNo new findings in changed code.")
    else:
        print("\nNo regressions. All findings within baseline.")
    return 0


def filter_sarif(mode, baseline_path, input_path, output_path):
    baseline = load_json(baseline_path)
    sarif = load_json(input_path)

    total_results = 0
    uploaded_results = 0
    for run in sarif.get("runs", []):
        results = run.get("results", [])
        total_results += len(results)

        if mode == "diff":
            uploaded_results += len(results)
            continue

        filtered = []
        seen = {}
        for result in results:
            rule_id = result.get("ruleId")
            seen[rule_id] = seen.get(rule_id, 0) + 1
            if seen[rule_id] > baseline.get(rule_id, 0):
                filtered.append(result)

        uploaded_results += len(filtered)
        run["results"] = filtered

    with Path(output_path).open("w") as destination:
        json.dump(sarif, destination)

    if mode == "diff":
        print(
            "Semgrep SARIF upload includes "
            f"{uploaded_results}/{total_results} new result(s)"
        )
    else:
        print(
            "Semgrep SARIF upload filtered: "
            f"{uploaded_results}/{total_results} result(s) exceed baseline"
        )


def parse_args():
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)

    check_parser = subparsers.add_parser("check")
    check_parser.add_argument("mode", choices=("diff", "full"))
    check_parser.add_argument("baseline")
    check_parser.add_argument("results")

    filter_parser = subparsers.add_parser("filter")
    filter_parser.add_argument("mode", choices=("diff", "full"))
    filter_parser.add_argument("baseline")
    filter_parser.add_argument("input")
    filter_parser.add_argument("output")

    return parser.parse_args()


def main():
    args = parse_args()
    if args.command == "check":
        return check_findings(args.mode, args.baseline, args.results)

    filter_sarif(args.mode, args.baseline, args.input, args.output)
    return 0


if __name__ == "__main__":
    sys.exit(main())
