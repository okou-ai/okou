"""Decode snapshot aggregates and retain only bounded PostgreSQL diagnostics."""

import json
import re
import subprocess


class ScanReportError(Exception):
    """Fixed error codes and validated metadata; never database values or SQL."""

    def __init__(self, code, diagnostics=None):
        super().__init__(code)
        self.diagnostics = diagnostics


def require(condition, code):
    if not condition:
        raise ScanReportError(code)


def counter(record, field):
    value = record.get(field)
    require(type(value) is int and value >= 0, "invalid_scan_counter")
    return value


def scan_records(result, database_hash):
    timed_out = isinstance(result, subprocess.TimeoutExpired)
    output = result.stdout or ""
    if timed_out:
        # A killed process can end halfway through JSON or a UTF-8 character.
        # Only complete lines may contribute diagnostic progress, never coverage.
        newline = b"\n" if isinstance(output, bytes) else "\n"
        output = output[: output.rfind(newline) + 1]
    if isinstance(output, bytes):
        output = output.decode("utf-8")
    safe, headers, last_scan = [], [], None
    plans = {}
    row_fields = {"rows", "rowsWithEnvelopeMarker", "rowsWithSourceReference"}
    fields = {
        "database": {"largeObjects", "foreignTables", "plannedTables"},
        "binary": {"relationOid", "columnNumber", "nonNullValues"},
    }
    for line in output.splitlines():
        if not line:
            continue
        record = json.loads(line)
        require(isinstance(record, dict), "invalid_scan_record")
        kind = record.get("kind")
        if kind == "table-plan":
            oid, blocks = counter(record, "relationOid"), counter(record, "blocks")
            require(oid not in plans and blocks > 0, "invalid_table_plan")
            require(
                record.get("heapAccessMethod") is True,
                "unsupported_table_access_method",
            )
            plans[oid] = {
                "blocks": blocks,
                "nextBlock": 0,
                "aggregate": {
                    "kind": "table",
                    "relationOid": oid,
                    **dict.fromkeys(row_fields, 0),
                },
            }
            continue
        if kind == "table-chunk":
            oid = counter(record, "relationOid")
            require(oid in plans, "unplanned_table_chunk")
            plan = plans[oid]
            first, end = counter(record, "firstBlock"), counter(record, "endBlock")
            require(
                first == plan["nextBlock"]
                and first < end
                and end == min(first + 128, plan["blocks"]),
                "noncontiguous_table_chunks",
            )
            counts = {field: counter(record, field) for field in row_fields}
            require(
                all(counts[field] <= counts["rows"] for field in row_fields),
                "invalid_row_counts",
            )
            for field, value in counts.items():
                plan["aggregate"][field] += value
            plan["nextBlock"] = end
            if end == plan["blocks"]:
                safe.append(plan["aggregate"])
            continue
        if kind == "scan-start":
            phase = record.get("phase")
            require(phase in {"table", "binary"}, "invalid_scan_phase")
            last_scan = {"phase": phase}
            for field in (
                ["relationOid", "relationBytes"]
                + (["columnNumber"] if phase == "binary" else [])
                + (
                    ["firstBlock", "endBlock"]
                    if "firstBlock" in record or "endBlock" in record
                    else []
                )
            ):
                last_scan[field] = counter(record, field)
            continue
        require(kind in fields, "unknown_scan_record")
        if kind == "database":
            headers.append(record)
        item = {"kind": kind}
        for field in fields[kind]:
            item[field] = counter(record, field)
        safe.append(item)
    if timed_out or result.returncode != 0:
        # VERBOSITY=sqlstate produces a code-only ERROR line. Arbitrary stderr,
        # including connection errors, provider messages and SQL, is discarded.
        stderr = result.stderr or ""
        if isinstance(stderr, bytes):
            stderr = stderr.decode("utf-8", errors="replace")
        states = re.findall(r"ERROR:\s+([0-9A-Z]{5})\s*$", stderr, re.MULTILINE)
        raise ScanReportError(
            "snapshot_database_scan_process_timeout"
            if timed_out
            else "snapshot_database_scan_failed",
            {
                "databaseNameSha256": database_hash,
                "psqlExitCode": None if timed_out else result.returncode,
                "sqlState": states[0] if len(states) == 1 else None,
                "completedTables": sum(r["kind"] == "table" for r in safe),
                "lastStartedScan": last_scan,
                **({"processTimeoutSeconds": result.timeout} if timed_out else {}),
            },
        )
    require(
        len(headers) == 1
        and headers[0].get("readOnly") is True
        and headers[0].get("isolation") == "repeatable read"
        and headers[0].get("supportsTidRangeScan") is True,
        "read_only_transaction_unverified",
    )
    require(
        len(plans) == headers[0]["plannedTables"]
        and all(plan["nextBlock"] == plan["blocks"] for plan in plans.values()),
        "incomplete_table_scan",
    )
    return safe
