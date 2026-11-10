#!/usr/bin/env python3
"""Validate and package an unsigned staging device archive for provider re-signing."""

import argparse
import base64
import hashlib
import json
import os
import plistlib
import stat
import struct
import subprocess
import tarfile
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo


def validate_device(path):
    data = path.read_bytes()
    if len(data) < 32 or struct.unpack_from("<II", data) != (0xFEEDFACF, 0x100000C):
        raise ValueError("Expected a 64-bit ARM device executable")
    cursor = 32
    for _ in range(struct.unpack_from("<I", data, 16)[0]):
        command, size = struct.unpack_from("<II", data, cursor)
        if size < 8 or cursor + size > len(data):
            raise ValueError("Invalid Mach-O load command")
        if command == 0x32 and size >= 24:
            if struct.unpack_from("<I", data, cursor + 8)[0] != 2:
                raise ValueError("Expected iPhoneOS, not a simulator executable")
            return
        cursor += size
    raise ValueError("Executable has no iOS build version")


def package(archive, output, version):
    app = archive / "Products/Applications/Okou.app"
    bundles = [app, app / "PlugIns/OkouNotificationService.appex"]
    infos = []
    for bundle, identifier in zip(bundles, ["ai.okou.ios", "ai.okou.ios.notifications"]):
        info = plistlib.loads((bundle / "Info.plist").read_bytes())
        if (
            info["CFBundleIdentifier"] != identifier
            or info["CFBundleShortVersionString"] != version
            or info["CFBundleSupportedPlatforms"] != ["iPhoneOS"]
            or info.get("APIBaseURL") != "https://staging-api.vm6.ai"
            or not info.get("ClerkPublishableKey", "").startswith("pk_test_")
            or info.get("SentryDSN")
            or info.get("ClerkKeychainAccessGroup")
            or (bundle / "embedded.mobileprovision").exists()
            or (bundle / "_CodeSignature").exists()
        ):
            raise ValueError("Expected an unsigned staging bundle with TEST authentication")
        key = info["ClerkPublishableKey"].removeprefix("pk_test_")
        frontend = base64.b64decode(key + "=" * (-len(key) % 4)).decode()
        if frontend != "informed-calf-6.clerk.accounts.dev$":
            raise ValueError("Staging must use the Web TEST authentication instance")
        validate_device(bundle / info["CFBundleExecutable"])
        infos.append(info)
    if (
        infos[0].get("WebBaseURL") != "https://staging-app-okou-app-preview.vm0.workers.dev"
        or infos[0]["CFBundleVersion"] != infos[1]["CFBundleVersion"]
        or infos[0]["ClerkPublishableKey"] != infos[1]["ClerkPublishableKey"]
    ):
        raise ValueError("Staging bundle environments or versions disagree")
    for path in archive.rglob("*"):
        if path.is_symlink() and (
            os.path.isabs(os.readlink(path))
            or not path.resolve().is_relative_to(archive.resolve())
        ):
            raise ValueError("Archive links must stay within the archive")

    output.mkdir(parents=True, exist_ok=True)
    ipa = output / "Okou-Staging.ipa"
    with ZipFile(ipa, "w", compression=ZIP_DEFLATED) as package_file:
        for path in sorted(app.rglob("*")):
            name = "Payload/Okou.app/" + str(path.relative_to(app))
            if path.is_symlink():
                entry = ZipInfo(name)
                entry.create_system = 3
                entry.external_attr = (stat.S_IFLNK | 0o777) << 16
                package_file.writestr(entry, os.readlink(path))
            else:
                package_file.write(path, name)
    archive_path = output / "archive.tar.gz"
    with tarfile.open(archive_path, "w:gz") as package_file:
        package_file.add(archive, arcname="Staging.xcarchive")
    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
    if os.environ.get("GITHUB_SHA", commit) != commit:
        raise ValueError("Archive checkout does not match the workflow SHA")
    manifest = {
        "version": 1,
        "purpose": "staging-device-qa",
        "commitSha": commit,
        "prHeadSha": os.environ.get("PR_HEAD_SHA") or None,
        "pullRequest": os.environ.get("PR_NUMBER") or None,
        "runId": os.environ.get("GITHUB_RUN_ID"),
        "runAttempt": os.environ.get("GITHUB_RUN_ATTEMPT"),
        "environment": "staging",
        "apiBaseURL": infos[0]["APIBaseURL"],
        "webBaseURL": infos[0]["WebBaseURL"],
        "clerkFrontendAPI": frontend.removesuffix("$"),
        "bundleId": infos[0]["CFBundleIdentifier"],
        "appVersion": version,
        "buildNumber": infos[0]["CFBundleVersion"],
        "minimumOSVersion": infos[0]["MinimumOSVersion"],
        "signing": "unsigned; BrowserStack re-signs on installation",
        "files": {},
    }
    for path in [ipa, archive_path]:
        with path.open("rb") as file:
            manifest["files"][path.name] = hashlib.file_digest(file, "sha256").hexdigest()
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps(manifest, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--version", required=True)
    args = parser.parse_args()
    package(args.archive, args.output, args.version)


if __name__ == "__main__":
    main()
