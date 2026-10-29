#!/usr/bin/env python3
"""Upload the verified archive's app/extension dSYMs; requires SENTRY_* CI credentials."""

import argparse
import os
from pathlib import Path
import subprocess
from uuid import UUID


def debug_ids(path):
    output = subprocess.check_output(
        ["xcrun", "dwarfdump", "--uuid", str(path)], text=True
    )
    identifiers = {
        str(UUID(line.split()[1]))
        for line in output.splitlines()
        if line.startswith("UUID: ")
    }
    if not identifiers:
        raise ValueError(f"No Mach-O UUIDs found in {path}")
    return identifiers


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("--cli", default="sentry-cli")
    args = parser.parse_args()
    for name in ("SENTRY_AUTH_TOKEN", "SENTRY_ORG", "SENTRY_PROJECT"):
        if not os.environ.get(name):
            parser.error(f"{name} is required for iOS symbol upload")

    app = args.archive / "Products/Applications/Okou.app"
    symbols = args.archive / "dSYMs"
    identifiers = set()
    for executable, dsym in (
        (app / "Okou", symbols / "Okou.app.dSYM"),
        (
            app / "PlugIns/OkouNotificationService.appex/OkouNotificationService",
            symbols / "OkouNotificationService.appex.dSYM",
        ),
    ):
        if not executable.is_file() or not dsym.is_dir():
            parser.error(f"Missing release executable or dSYM: {executable.name}")
        expected = debug_ids(executable)
        if debug_ids(dsym) != expected:
            parser.error(f"dSYM UUIDs do not match {executable.name}")
        identifiers.update(expected)

    command = [
        args.cli,
        "debug-files",
        "upload",
        "--type",
        "dsym",
        "--require-all",
        "--wait-for",
        "300",
    ]
    for identifier in sorted(identifiers):
        command.extend(("--id", identifier))
    # Authentication stays in the environment, never process arguments or archive contents.
    subprocess.run(command + [str(symbols)], check=True, timeout=600)


if __name__ == "__main__":
    main()
