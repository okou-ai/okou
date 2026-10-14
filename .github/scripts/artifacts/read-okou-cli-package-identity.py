#!/usr/bin/env python3
"""Read the mandatory CLI identity from one bounded package, without extracting it."""

import gzip
import json
import os
from pathlib import PurePosixPath
import re
import stat
import sys
import tarfile

MAX_PACKAGE_BYTES = 64 * 1024 * 1024
MAX_ARCHIVE_BYTES = 256 * 1024 * 1024
MAX_METADATA_BYTES = 16 * 1024
RELEASE_VERSION = re.compile(r"(?:0|[1-9][0-9]{0,9})\.(?:0|[1-9][0-9]{0,9})\.(?:0|[1-9][0-9]{0,9})")


class JsonObject(list):
    pass


class JsonInteger:
    def __init__(self, token):
        self.token = token


def fields(value, consumed):
    if not isinstance(value, JsonObject):
        raise ValueError("CLI package identity must contain objects")
    result = {}
    for key, item in value:
        if key in consumed:
            if key in result:
                raise ValueError("duplicate CLI package identity field")
            result[key] = item
    if not all(key in result for key in consumed):
        raise ValueError("missing CLI package identity field")
    return result


def invalid_constant(value):
    raise ValueError("invalid JSON constant: " + value)


class ArchiveReader:
    def __init__(self, stream):
        self.stream = stream
        self.remaining = MAX_ARCHIVE_BYTES

    def read(self, size=-1):
        if size < 0:
            size = self.remaining + 1
        data = self.stream.read(min(size, self.remaining + 1))
        self.remaining -= len(data)
        if self.remaining < 0:
            raise ValueError("CLI package decompressed size exceeds limit")
        return data


def read_identity(path):
    flags = os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW
    with os.fdopen(os.open(path, flags), "rb") as source:
        info = os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode) or not 0 < info.st_size <= MAX_PACKAGE_BYTES:
            raise ValueError("CLI package size/type is invalid")
        with gzip.GzipFile(fileobj=source) as decoded:
            reader = ArchiveReader(decoded)
            metadata = None
            with tarfile.open(fileobj=reader, mode="r|") as archive:
                for entry in archive:
                    path = PurePosixPath(entry.name)
                    if path.is_absolute() or ".." in path.parts:
                        raise ValueError("unsafe CLI package path")
                    if path != PurePosixPath("package/package.json"):
                        continue
                    if (entry.name != "package/package.json" or metadata is not None
                            or entry.type not in (tarfile.REGTYPE, tarfile.AREGTYPE)):
                        raise ValueError("CLI package requires one regular package.json")
                    if not 0 < entry.size <= MAX_METADATA_BYTES:
                        raise ValueError("CLI package metadata size exceeds limit")
                    with archive.extractfile(entry) as file:
                        metadata = file.read(MAX_METADATA_BYTES + 1)
            # Finish gzip integrity and resource checks even after tar's end marker.
            while reader.read(64 * 1024):
                pass
    if metadata is None:
        raise ValueError("CLI package is missing package.json")
    package = fields(json.loads(
        metadata.decode("utf-8"), object_pairs_hook=JsonObject,
        parse_int=JsonInteger, parse_constant=invalid_constant,
    ), ("name", "version", "okouBuildIdentity"))
    build = fields(package["okouBuildIdentity"],
                   ("schemaVersion", "piAgentRuntime", "piSdk", "sessionConstruction"))
    session = fields(build["sessionConstruction"], ("digest",))
    if package["name"] != "@okouai/cli":
        raise ValueError("unexpected CLI package name")
    if not isinstance(build["schemaVersion"], JsonInteger) or build["schemaVersion"].token != "1":
        raise ValueError("unsupported CLI package identity schema")
    for value in (package["version"], build["piAgentRuntime"]):
        if not isinstance(value, str) or not RELEASE_VERSION.fullmatch(value):
            raise ValueError("invalid CLI package release version")
    sdk = build["piSdk"]
    if not isinstance(sdk, str):
        raise ValueError("invalid CLI package SDK identity")
    parts = sdk.split("+okou.")
    if len(parts) != 2 or not RELEASE_VERSION.fullmatch(parts[0]) or not re.fullmatch(r"[0-9a-f]{12}", parts[1]):
        raise ValueError("invalid CLI package SDK identity")
    digest = session["digest"]
    if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
        raise ValueError("invalid CLI package session digest")
    return {"versions": {"cli": package["version"], "piAgentRuntime": build["piAgentRuntime"],
                         "piSdk": sdk}, "sessionConstruction": {"digest": digest}}


if __name__ == "__main__":
    try:
        if len(sys.argv) != 2:
            raise ValueError("usage: read-okou-cli-package-identity.py <package.tgz>")
        print(json.dumps(read_identity(sys.argv[1]), separators=(",", ":"), sort_keys=True))
    except (OSError, ValueError, tarfile.TarError, EOFError, RecursionError) as error:
        print("Invalid CLI package identity: " + str(error), file=sys.stderr)
        sys.exit(1)
