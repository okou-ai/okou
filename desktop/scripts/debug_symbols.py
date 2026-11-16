#!/usr/bin/env python3
"""Verify native dSYMs against app/package UUIDs, optionally upload to Sentry.

Requires macOS/Xcode tools. Upload additionally requires sentry-cli on PATH and
SENTRY_AUTH_TOKEN, SENTRY_ORG and SENTRY_PROJECT. Any mismatch or upload/processing
or readback failure exits nonzero; source files are never included in the upload.
"""

import argparse
import hashlib
import json
import os
import plistlib
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from urllib.parse import parse_qs, quote, urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener
from uuid import UUID


def uuids(path):
    output = subprocess.check_output(["dwarfdump", "--uuid", str(path)], text=True)
    identifiers = {}
    for line in output.splitlines():
        match = re.fullmatch(r"UUID: ([0-9A-Fa-f-]{36}) \((\w+)\) .+", line)
        if not match or match[2] in identifiers:
            raise ValueError(f"Invalid or duplicate Mach-O UUID: {path}")
        identifiers[match[2]] = str(UUID(match[1]))
    if set(identifiers) != {"arm64"}:
        raise ValueError(f"Expected exactly one arm64 UUID: {path}")
    return identifiers


def verify_symbols(app, symbols):
    info = plistlib.loads((app / "Contents/Info.plist").read_bytes())
    executable = info["CFBundleExecutable"]
    if (
        not isinstance(executable, str)
        or not executable
        or Path(executable).name != executable
    ):
        raise ValueError("Invalid app executable name")
    pairs = [
        (app / "Contents/MacOS" / executable, f"{app.name}.dSYM", executable),
        (
            app / "Contents/Helpers/computer-use-helper",
            "computer-use-helper.dSYM",
            "computer-use-helper",
        ),
    ]
    if symbols.is_symlink() or {p.name for p in symbols.iterdir()} != {
        p[1] for p in pairs
    }:
        raise ValueError(f"Expected app and helper dSYM bundles: {symbols}")
    for path in symbols.rglob("*"):
        if path.is_symlink() or not (path.is_dir() or path.is_file()):
            raise ValueError(f"Unexpected debug symbols entry: {path}")
    verified = []
    for binary, bundle, name in pairs:
        dwarf = symbols / bundle / "Contents/Resources/DWARF" / name
        if not dwarf.is_file():
            raise ValueError(f"Missing DWARF file: {dwarf}")
        binary_ids = uuids(binary)
        if binary_ids != uuids(dwarf):
            raise ValueError(f"Binary/dSYM UUID mismatch: {binary} and {dwarf}")
        print(f"Verified {binary}: {binary_ids}", flush=True)
        verified.append(dwarf)
    return verified


def verify_packages(symbols, app_name, archive=None, dmg=None):
    if archive:
        with tempfile.TemporaryDirectory(prefix="okou-symbols-zip-") as directory:
            subprocess.run(["ditto", "-x", "-k", str(archive), directory], check=True)
            verify_symbols(Path(directory) / app_name, symbols)
    if dmg:
        # Do not recursively remove a mount point if detaching fails.
        mount = Path(tempfile.mkdtemp(prefix="okou-symbols-dmg-"))
        try:
            subprocess.run(
                [
                    "hdiutil",
                    "attach",
                    str(dmg),
                    "-nobrowse",
                    "-readonly",
                    "-mountpoint",
                    str(mount),
                ],
                check=True,
            )
            verify_symbols(mount / app_name, symbols)
        finally:
            if mount.is_mount():
                subprocess.run(["hdiutil", "detach", str(mount)], check=True)
            shutil.rmtree(mount)


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
            and record["cpuName"] == "arm64"
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
        # Keep authenticated pagination on the configured origin and project.
        next_url = next_page.split(">", 1)[0].strip(" <")
        query["cursor"] = parse_qs(urlsplit(next_url).query)["cursor"][0]
    raise ValueError(f"Cannot verify Sentry dSYM checksum/debug info: {identifier}")


def upload_symbols(files):
    for name in ("SENTRY_AUTH_TOKEN", "SENTRY_ORG", "SENTRY_PROJECT"):
        if not os.environ.get(name):
            raise ValueError(f"{name} is required for debug symbol upload")
    checksums = {}
    for path in files:
        subprocess.run(["sentry-cli", "debug-files", "check", str(path)], check=True)
        with path.open("rb") as file:
            checksum = hashlib.file_digest(file, "sha1").hexdigest()
        for identifier in uuids(path).values():
            checksums[identifier] = checksum
    command = [
        "sentry-cli",
        "debug-files",
        "upload",
        "--type",
        "dsym",
        "--wait-for",
        "600",
    ]
    for identifier in sorted(checksums):
        command += ["--id", identifier]
    subprocess.run([*command, *map(str, files)], check=True)
    # sentry-cli 2.58.5's --require-all omits files already present on the server.
    # Verify every canonical file after processing, including files reused on reruns.
    for identifier, checksum in sorted(checksums.items()):
        verify_uploaded_symbol(identifier, checksum)
    print(f"Verified {len(checksums)} canonical dSYM UUIDs in Sentry", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", required=True, type=Path)
    parser.add_argument("--symbols", required=True, type=Path)
    parser.add_argument("--zip", type=Path)
    parser.add_argument("--dmg", type=Path)
    parser.add_argument("--upload", action="store_true")
    args = parser.parse_args()
    files = verify_symbols(args.app, args.symbols)
    verify_packages(args.symbols, args.app.name, args.zip, args.dmg)
    if args.upload:
        upload_symbols(files)


if __name__ == "__main__":
    main()
