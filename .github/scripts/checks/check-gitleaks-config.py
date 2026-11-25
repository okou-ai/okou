#!/usr/bin/env python3
"""Verify effective secret detection with a generated, never-issued PAT fixture.

Requires Python 3 and gitleaks on PATH. Uses this checkout's configuration from
any working directory, prints no fixture contents, and fails on missed detection
or scanner errors. Temporary files are removed on success and failure.
"""

import json
from pathlib import Path
import secrets
import string
import subprocess
import tempfile


def main():
    config = Path(__file__).resolve().parents[3] / ".gitleaks.toml"
    with tempfile.TemporaryDirectory(prefix="gitleaks-positive-control-") as tmp:
        root = Path(tmp)
        fixture = root / "input"
        fixture.mkdir()
        token = "ghp_" + "".join(
            secrets.choice(string.ascii_letters + string.digits) for _ in range(36)
        )
        (fixture / "canary.conf").write_text(f'token = "{token}"\n')
        report = root / "report.json"
        result = subprocess.run(
            [
                "gitleaks", "dir", str(fixture), "--config", str(config),
                "--redact=100", "--no-banner", "--exit-code=42",
                "--report-format=json", "--report-path", str(report),
            ],
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
        if result.returncode != 42:
            raise SystemExit(
                "Gitleaks positive control failed: expected detection exit 42, "
                f"received {result.returncode}."
            )
        findings = json.loads(report.read_text())
        if not any(
            finding.get("RuleID") == "github-pat"
            and Path(finding.get("File", "")).name == "canary.conf"
            for finding in findings
        ):
            raise SystemExit("Gitleaks did not identify the synthetic PAT fixture.")
    print("Gitleaks detected the generated positive-control fixture.")


if __name__ == "__main__":
    main()
