#!/usr/bin/env python3
"""Upload the verified archive's app/extension dSYMs; requires SENTRY_* CI credentials."""

import argparse
import hashlib
import json
import os
import subprocess
from pathlib import Path
from urllib.parse import parse_qs, quote, urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener
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


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def verify_uploaded_symbol(identifier, checksum):
    base = os.environ.get("SENTRY_URL", "https://sentry.io").rstrip("/")
    org = quote(os.environ["SENTRY_ORG"], safe="")
    project = quote(os.environ["SENTRY_PROJECT"], safe="")
    endpoint = f"{base}/api/0/projects/{org}/{project}/files/dsyms/"
    query = {"debug_id": identifier, "file_formats": "macho", "per_page": 100}
    opener = build_opener(NoRedirect())
    for _ in range(10):
        request = Request(
            f"{endpoint}?{urlencode(query)}",
            headers={"Authorization": f"Bearer {os.environ['SENTRY_AUTH_TOKEN']}"},
        )
        with opener.open(request, timeout=30) as response:
            records = json.load(response)
            links = response.headers.get("Link", "")
        if any(
            record["debugId"] == identifier
            and record["sha1"] == checksum
            and "debug" in record["data"]["features"]
            for record in records
        ):
            return
        next_page = next(
            (
                link
                for link in links.split(",")
                if 'rel="next"' in link and 'results="true"' in link
            ),
            None,
        )
        if next_page is None:
            break
        # Reuse only the cursor, keeping the authenticated request on this project.
        next_url = next_page.split(">", 1)[0].strip(" <")
        query["cursor"] = parse_qs(urlsplit(next_url).query)["cursor"][0]
    raise ValueError(f"Cannot verify Sentry dSYM checksum/debug info: {identifier}")


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
    checksums = {}
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
        with (dsym / "Contents/Resources/DWARF" / executable.name).open("rb") as file:
            checksum = hashlib.file_digest(file, "sha1").hexdigest()
        for identifier in expected:
            checksums[identifier] = checksum

    command = [
        args.cli,
        "debug-files",
        "upload",
        "--type",
        "dsym",
        "--wait-for",
        "300",
    ]
    for identifier in sorted(checksums):
        command.extend(("--id", identifier))
    # Authentication stays in the environment, never process arguments or archive contents.
    subprocess.run(command + [str(symbols)], check=True, timeout=600)
    # sentry-cli 2.58.5's --require-all omits files already present on the server.
    # Verify all canonical files after processing, including uploads reused on reruns.
    for identifier, checksum in sorted(checksums.items()):
        verify_uploaded_symbol(identifier, checksum)
    print(f"Verified {len(checksums)} canonical dSYM UUIDs in Sentry")


if __name__ == "__main__":
    main()
