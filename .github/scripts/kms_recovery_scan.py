"""Decode snapshot aggregates and retain only bounded PostgreSQL diagnostics."""

import json
import re


class ScanReportError(Exception):
    """Fixed error codes and validated metadata; never database values or SQL."""

    def __init__(self, code, diagnostics=None):
        super().__init__(code)
        self.diagnostics = diagnostics


def require(condition, code):
    if not condition:
        raise ScanReportError(code)


def scan_records(result, database_hash):
    safe, headers, last_scan = [], [], None
    fields = {
        "database": {"largeObjects", "foreignTables"},
        "table": {
            "relationOid",
            "rows",
            "rowsWithEnvelopeMarker",
            "rowsWithSourceReference",
        },
        "binary": {"relationOid", "columnNumber", "nonNullValues"},
    }
    for line in result.stdout.splitlines():
        if not line:
            continue
        record = json.loads(line)
        require(isinstance(record, dict), "invalid_scan_record")
        kind = record.get("kind")
        if kind == "scan-start":
            phase = record.get("phase")
            require(phase in {"table", "binary"}, "invalid_scan_phase")
            last_scan = {"phase": phase}
            for field in ["relationOid", "relationBytes"] + (
                ["columnNumber"] if phase == "binary" else []
            ):
                value = record.get(field)
                require(type(value) is int and value >= 0, "invalid_scan_counter")
                last_scan[field] = value
            continue
        require(kind in fields, "unknown_scan_record")
        if kind == "database":
            headers.append(record)
        item = {"kind": kind}
        for field in fields[kind]:
            value = record.get(field)
            require(type(value) is int and value >= 0, "invalid_scan_counter")
            item[field] = value
        safe.append(item)
    if result.returncode != 0:
        # VERBOSITY=sqlstate produces a code-only ERROR line. Arbitrary stderr,
        # including connection errors, provider messages and SQL, is discarded.
        states = re.findall(r"ERROR:\s+([0-9A-Z]{5})\s*$", result.stderr, re.MULTILINE)
        raise ScanReportError(
            "snapshot_database_scan_failed",
            {
                "databaseNameSha256": database_hash,
                "psqlExitCode": result.returncode,
                "sqlState": states[0] if len(states) == 1 else None,
                "completedTables": sum(r["kind"] == "table" for r in safe),
                "lastStartedScan": last_scan,
            },
        )
    require(
        len(headers) == 1
        and headers[0].get("readOnly") is True
        and headers[0].get("isolation") == "repeatable read",
        "read_only_transaction_unverified",
    )
    return safe
