#!/usr/bin/env python3
"""Run the fixed read-only inventory and atomically publish one aggregate report."""

import json
import os
from pathlib import Path
import re
import sys
import tempfile

import psycopg


def main():
    if len(sys.argv) != 2 or not os.environ.get("DATABASE_URL"):
        raise ValueError("DATABASE_URL and one new output path are required")
    output = Path(sys.argv[1])
    if output.exists():
        raise ValueError("Refusing to overwrite an existing report")

    # Direct connection: startup options must reach PostgreSQL, not a pooler.
    # Autocommit executes the single SELECT without an explicit transaction.
    with psycopg.connect(
        os.environ["DATABASE_URL"],
        autocommit=True,
        connect_timeout=15,
        application_name="link-wallet-retirement-audit",
        options="-c default_transaction_read_only=on -c statement_timeout=30000 -c lock_timeout=5000",
    ) as connection:
        report = connection.execute(Path(__file__).with_name("audit.sql").read_text()).fetchone()[0]
    if report["readOnly"] is not True or not isinstance(report["observedAt"], str):
        raise ValueError("Inventory did not establish a read-only snapshot")
    for section in ("connections", "oauthAttempts"):
        for count in report[section].values():
            if not isinstance(count, str) or not re.fullmatch(r"0|[1-9][0-9]*", count):
                raise ValueError("Inventory count is not an exact nonnegative integer")

    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", dir=output.parent, delete=False) as stream:
            temporary = Path(stream.name)
            json.dump(report, stream, indent=2)
            stream.write("\n")
        temporary.replace(output)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Raw database errors can include connection details or persisted values.
        print(f"Wallet inventory failed ({type(error).__name__}); no report published.", file=sys.stderr)
        sys.exit(1)
