#!/usr/bin/env python3
"""Run the actual aggregate SQL in an isolated local PostgreSQL cluster."""

import hashlib
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from kms_recovery_scan import ScanReportError, scan_records

SQL = Path(__file__).resolve().parents[1] / "kms-recovery-snapshot-inventory.sql"


class SnapshotSqlTest(unittest.TestCase):
    def test_aggregate_inventory_preserves_data_and_handles_partition_and_binary_values(
        self,
    ):
        binary = Path(
            subprocess.check_output(["pg_config", "--bindir"], text=True).strip()
        )
        with tempfile.TemporaryDirectory(prefix="kms-snapshot-sql-") as directory:
            root = Path(directory)
            data = root / "data"
            subprocess.run(
                [str(binary / "initdb"), "-D", str(data), "-A", "trust", "--no-locale"],
                check=True,
                capture_output=True,
            )
            with (data / "postgresql.conf").open("a") as stream:
                stream.write(
                    "\nlisten_addresses = ''\nunix_socket_directories = '"
                    + str(root)
                    + "'\n"
                )
            subprocess.run(
                [
                    str(binary / "pg_ctl"),
                    "-D",
                    str(data),
                    "-l",
                    str(root / "server.log"),
                    "start",
                    "-w",
                ],
                check=True,
                capture_output=True,
            )
            environment = {
                k: v for k, v in os.environ.items() if not k.startswith("PG")
            }
            environment.update(
                {"PGHOST": str(root), "PGPORT": "5432", "PGDATABASE": "postgres"}
            )

            def psql(*args, sql=None):
                return subprocess.run(
                    ["psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", *args],
                    input=sql,
                    env=environment,
                    capture_output=True,
                    text=True,
                    timeout=30,
                    check=False,
                )

            try:
                fixture = psql(
                    sql="""
                    CREATE TABLE public.secret_probe(id int, value text, payload jsonb, binary_value bytea);
                    INSERT INTO public.secret_probe VALUES
                      (1, 'vm0secret:v1:test-only', '{"nested":"vm0secret:v1:synthetic"}', NULL),
                      (2, 'synthetic a1b3922b-fab1-4ed3-aa9e-40f86f92a7a8', '{}', decode('abc0','hex')),
                      (3, 'private-plaintext-must-stay-in-db', '{}', NULL);
                    CREATE TABLE public.part_probe(id int, value text) PARTITION BY RANGE(id);
                    CREATE TABLE public.part_leaf PARTITION OF public.part_probe FOR VALUES FROM(0) TO(10);
                    INSERT INTO public.part_probe VALUES(1, 'vm0secret:v1:partition');
                    CREATE MATERIALIZED VIEW public.mat_probe AS SELECT id,value FROM public.secret_probe WHERE id=1;
                    CREATE SCHEMA "odd-schema";
                    CREATE TABLE "odd-schema"."quoted'name"(val text);
                    INSERT INTO "odd-schema"."quoted'name" VALUES('vm0secret:v1:quoted');
                """
                )
                self.assertEqual(fixture.returncode, 0, fixture.stderr)
                result = psql("-f", str(SQL))
                self.assertEqual(result.returncode, 0, result.stderr)
                records = [
                    json.loads(line) for line in result.stdout.splitlines() if line
                ]
                tables = [r for r in records if r["kind"] == "table"]
                self.assertEqual(len(tables), 4)
                self.assertEqual(sum(r["rows"] for r in tables), 6)
                self.assertEqual(sum(r["rowsWithEnvelopeMarker"] for r in tables), 4)
                self.assertEqual(sum(r["rowsWithSourceReference"] for r in tables), 1)
                self.assertEqual(
                    sum(r["nonNullValues"] for r in records if r["kind"] == "binary"), 1
                )
                self.assertTrue(records[0]["readOnly"])
                self.assertEqual(records[0]["isolation"], "repeatable read")
                self.assertNotIn("private-plaintext", result.stdout)
                self.assertNotIn("vm0secret", result.stdout)
                self.assertEqual(
                    psql(
                        "-c", "SELECT count(*) FROM public.secret_probe"
                    ).stdout.strip(),
                    "3",
                )
                role = psql("-c", "CREATE ROLE snapshot_scan_reader LOGIN")
                self.assertEqual(role.returncode, 0, role.stderr)
                denied = psql("-U", "snapshot_scan_reader", "-f", str(SQL))
                self.assertNotEqual(denied.returncode, 0)
                self.assertNotIn("private-plaintext", denied.stdout + denied.stderr)
                with self.assertRaises(ScanReportError) as raised:
                    scan_records(denied, hashlib.sha256(b"postgres").hexdigest())
                self.assertEqual(raised.exception.diagnostics["sqlState"], "42501")
                self.assertEqual(
                    raised.exception.diagnostics["lastStartedScan"]["relationOid"],
                    tables[0]["relationOid"],
                )
                self.assertEqual(raised.exception.diagnostics["completedTables"], 0)
            finally:
                subprocess.run(
                    [
                        str(binary / "pg_ctl"),
                        "-D",
                        str(data),
                        "stop",
                        "-m",
                        "fast",
                        "-w",
                    ],
                    check=True,
                    capture_output=True,
                )


if __name__ == "__main__":
    unittest.main()
