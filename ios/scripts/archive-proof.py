#!/usr/bin/env python3
"""Prepare an unsigned device archive and verify an exported IPA without compiling."""

import argparse
import hashlib
import json
import os
import plistlib
import re
import shutil
import struct
from pathlib import Path
from zipfile import ZipFile

APP_ID = "ai.okou.ios"
APP_PATH = Path("Products/Applications/Okou.app")


def read_plist(path):
    with path.open("rb") as file:
        return plistlib.load(file)


def write_plist(path, value):
    with path.open("wb") as file:
        plistlib.dump(value, file)


def validate_archive(archive, version):
    if not archive.is_dir() or archive.is_symlink():
        raise ValueError("Expected a real xcarchive directory")
    for path in archive.rglob("*"):
        if path.is_symlink() and (
            os.path.isabs(os.readlink(path))
            or not path.resolve().is_relative_to(archive.resolve())
        ):
            raise ValueError(
                "Archive symlink must be relative and stay inside the archive"
            )
    app = archive / APP_PATH
    applications = archive / "Products/Applications"
    if sorted(path.name for path in applications.iterdir()) != ["Okou.app"]:
        raise ValueError("Expected one Okou application")
    if list(app.rglob("*.appex")) or list(app.rglob("*.app")):
        raise ValueError(
            "Nested application targets need an explicit version/signing policy"
        )
    info = read_plist(app / "Info.plist")
    if info["CFBundleIdentifier"] != APP_ID:
        raise ValueError("Unexpected application identifier")
    if info["CFBundleShortVersionString"] != version:
        raise ValueError("Archive version does not match the release version")
    if info["CFBundleSupportedPlatforms"] != ["iPhoneOS"]:
        raise ValueError("A device archive is required, not a simulator build")
    if info["CFBundleExecutable"] != "Okou" or not (app / "Okou").is_file():
        raise ValueError("Expected the Okou executable")
    if (app / "_CodeSignature").exists() or (app / "embedded.mobileprovision").exists():
        raise ValueError("Expected an unsigned, unprovisioned archive")
    archive_info = read_plist(archive / "Info.plist")
    properties = archive_info["ApplicationProperties"]
    if properties["ApplicationPath"] != "Applications/Okou.app":
        raise ValueError("Unexpected archive application path")
    for key in ("CFBundleIdentifier", "CFBundleShortVersionString", "CFBundleVersion"):
        if properties[key] != info[key]:
            raise ValueError("Archive and application metadata disagree")
    if not (archive / "dSYMs/Okou.app.dSYM").is_dir():
        raise ValueError("Release archive is missing application symbols")
    return app, info, archive_info


def file_digests(directory):
    return {
        str(path.relative_to(directory)): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in directory.rglob("*")
        if path.is_file()
    }


def prepare(source, destination, version, build_number):
    if not re.fullmatch(r"[1-9][0-9]{0,3}", build_number):
        raise ValueError("Build number must be an integer from 1 through 9999")
    if destination.exists() or destination.resolve().is_relative_to(source.resolve()):
        raise ValueError("Use a new destination outside the source archive")
    _, info, archive_info = validate_archive(source, version)
    before = file_digests(source)
    shutil.copytree(source, destination, symlinks=True)
    info["CFBundleVersion"] = build_number
    archive_info["ApplicationProperties"]["CFBundleVersion"] = build_number
    write_plist(destination / APP_PATH / "Info.plist", info)
    write_plist(destination / "Info.plist", archive_info)
    validate_archive(destination, version)
    after = file_digests(destination)
    allowed = {"Info.plist", str(APP_PATH / "Info.plist")}
    changed = {
        name
        for name in before.keys() | after.keys()
        if before.get(name) != after.get(name)
    }
    if changed - allowed or file_digests(source) != before:
        raise ValueError(
            "Preparing the archive changed compiled code, symbols, or its source"
        )
    print(json.dumps({"buildNumber": build_number, "changedFiles": sorted(changed)}))


def macho_sections(data):
    """Fingerprint compiled sections, excluding the code signature in __LINKEDIT."""
    if data[:4] in (b"\xca\xfe\xba\xbe", b"\xca\xfe\xba\xbf"):
        wide = data[:4] == b"\xca\xfe\xba\xbf"
        count = struct.unpack_from(">I", data, 4)[0]
        if count == 0:
            raise ValueError("Universal Mach-O contains no slices")
        stride = 32 if wide else 20
        result = {}
        for index in range(count):
            offset = 8 + index * stride
            cpu, subtype = struct.unpack_from(">II", data, offset)
            start, size = struct.unpack_from(">QQ" if wide else ">II", data, offset + 8)
            sections = macho_sections(data[start : start + size])
            if sections is None:
                raise ValueError("Unsupported Mach-O slice")
            result[f"{cpu}:{subtype}"] = sections
        return result
    if data[:4] != b"\xcf\xfa\xed\xfe":
        return None
    cpu, subtype = struct.unpack_from("<II", data, 4)
    command_count = struct.unpack_from("<I", data, 16)[0]
    cursor = 32
    sections = {}
    for _ in range(command_count):
        command, size = struct.unpack_from("<II", data, cursor)
        if size < 8 or cursor + size > len(data):
            raise ValueError("Invalid Mach-O load command")
        if command == 0x19:  # LC_SEGMENT_64
            section_count = struct.unpack_from("<I", data, cursor + 64)[0]
            if 72 + section_count * 80 > size:
                raise ValueError("Invalid Mach-O section table")
            for index in range(section_count):
                section = cursor + 72 + index * 80
                name = data[section : section + 16].split(b"\0")[0].decode()
                segment = data[section + 16 : section + 32].split(b"\0")[0].decode()
                length = struct.unpack_from("<Q", data, section + 40)[0]
                start = struct.unpack_from("<I", data, section + 48)[0]
                kind = struct.unpack_from("<I", data, section + 64)[0] & 0xFF
                if segment == "__LINKEDIT" or kind in (1, 12, 18):  # Zero-fill sections
                    continue
                if start + length > len(data):
                    raise ValueError("Mach-O section escapes its file")
                sections[f"{segment}:{name}"] = hashlib.sha256(
                    data[start : start + length]
                ).hexdigest()
        cursor += size
    if "__TEXT:__text" not in sections:
        raise ValueError("Compiled executable has no text section")
    return {f"{cpu}:{subtype}": sections}


def verify_export(source, ipa, version, build_number):
    app, _, _ = validate_archive(source, version)
    if macho_sections((app / "Okou").read_bytes()) is None:
        raise ValueError("Application executable is not a supported Mach-O binary")
    with ZipFile(ipa) as package:
        names = package.namelist()
        if len(names) != len(set(names)):
            raise ValueError("IPA contains duplicate paths")
        info = plistlib.loads(package.read("Payload/Okou.app/Info.plist"))
        if (
            info["CFBundleIdentifier"] != APP_ID
            or info["CFBundleShortVersionString"] != version
            or info["CFBundleVersion"] != build_number
        ):
            raise ValueError("Exported IPA has the wrong release identity")
        if "Payload/Okou.app/embedded.mobileprovision" not in names:
            raise ValueError("Exported IPA has no provisioning profile")
        if "Payload/Okou.app/_CodeSignature/CodeResources" not in names:
            raise ValueError("Exported IPA is not signed")
        count = 0
        for path in app.rglob("*"):
            if not path.is_file():
                continue
            original = macho_sections(path.read_bytes())
            if original is not None:
                exported = package.read(
                    "Payload/Okou.app/" + str(path.relative_to(app))
                )
                if macho_sections(exported) != original:
                    raise ValueError("Export changed compiled Mach-O sections")
                count += 1
        if count == 0:
            raise ValueError("Archive contains no compiled Mach-O code")
    print(json.dumps({"buildNumber": build_number, "verifiedMachOFiles": count}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    for name in ("prepare", "verify-export"):
        command = subparsers.add_parser(name)
        command.add_argument("source", type=Path)
        command.add_argument("output", type=Path)
        command.add_argument("--version", required=True)
        command.add_argument("--build-number", required=True)
    validate = subparsers.add_parser("validate")
    validate.add_argument("source", type=Path)
    validate.add_argument("--version", required=True)
    args = parser.parse_args()
    if args.command == "validate":
        validate_archive(args.source, args.version)
    elif args.command == "prepare":
        prepare(args.source, args.output, args.version, args.build_number)
    else:
        verify_export(args.source, args.output, args.version, args.build_number)


if __name__ == "__main__":
    main()
