#!/usr/bin/env python3
"""Restore Release diagnostics with the matching APK, gzip map and AGP Retrace.

Usage: retrace-release.py APK MAPPING.txt.gz INPUT OUTPUT_DIRECTORY [--r8-jar JAR]
INPUT is a stack-trace file or managed-device results directory. Original files
are never rewritten. Requires the README's JDK/SDK setup and the pinned Gradle.
"""

import argparse
import gzip
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tempfile
import zipfile


def sha256(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def restore(apk, mapping_gz, source, output, r8_jar):
    with gzip.open(mapping_gz, "rb") as stream:
        mapping = stream.read()
    compiler_match = re.search(rb"^# compiler_version: (\S+)\r?$", mapping, re.MULTILINE)
    map_id_match = re.search(rb"^# pg_map_id: (\S+)\r?$", mapping, re.MULTILINE)
    map_hash = re.search(rb"^# pg_map_hash: SHA-256 ([0-9a-f]{64})\r?\n", mapping, re.MULTILINE)
    if compiler_match is None or map_id_match is None or map_hash is None:
        raise ValueError("Mapping must contain an R8 compiler version, pg_map_id and SHA-256 hash")
    if hashlib.sha256(mapping[map_hash.end():]).hexdigest() != map_hash[1].decode("ascii"):
        raise ValueError("R8 mapping content does not match its SHA-256 hash")
    compiler = compiler_match[1].decode("ascii")
    map_id = map_id_match[1].decode("ascii")
    with zipfile.ZipFile(apk) as archive:
        markers = [
            json.loads(marker)
            for name in archive.namelist()
            if re.fullmatch(r"classes\d*\.dex", name)
            for marker in re.findall(rb"~~R8(\{[^\x00]*?\})", archive.read(name))
        ]
    if not markers or any(
        marker.get("pg-map-id") != map_id or marker.get("version") != compiler
        for marker in markers
    ):
        raise ValueError("APK and R8 mapping identities do not match")

    if r8_jar is None:
        android = Path(__file__).resolve().parents[1]
        result = subprocess.run(
            [str(android / "gradlew"), "--quiet", ":app:printRetraceClasspath", "--no-daemon"],
            cwd=android, check=True, capture_output=True, text=True,
        )
        r8_jar = Path(result.stdout.strip())
    command = ["java", "-cp", str(r8_jar), "com.android.tools.r8.retrace.Retrace"]
    version = subprocess.run(command + ["--version"], check=True, capture_output=True, text=True)
    if not version.stdout.startswith(f"Retrace {compiler} "):
        raise ValueError("Retrace must use the same R8 version as the APK")

    files = (
        sorted(path for path in source.rglob("*") if path.suffix in {".txt", ".log", ".xml"})
        if source.is_dir() else [source]
    )
    if not files:
        raise ValueError("No managed-device diagnostics were found")
    output.mkdir(parents=True, exist_ok=False)
    restored = []
    with tempfile.TemporaryDirectory(prefix="okou-retrace-") as directory:
        raw_map = Path(directory) / "mapping.txt"
        raw_map.write_bytes(mapping)
        for path in files:
            relative = path.relative_to(source) if source.is_dir() else Path(path.name)
            destination = output / relative.with_name(relative.name + ".retraced.txt")
            destination.parent.mkdir(parents=True, exist_ok=True)
            with destination.open("x", encoding="utf-8") as stream:
                subprocess.run(command + [str(raw_map), str(path)], check=True, stdout=stream)
            restored.append({"source": str(path), "sha256": sha256(path),
                             "restored": str(destination)})
    (output / "identity.json").write_text(json.dumps({
        "apk": str(apk), "apkSha256": sha256(apk),
        "mapping": str(mapping_gz), "mappingSha256": sha256(mapping_gz),
        "r8Version": compiler, "mapId": map_id, "files": restored,
    }, indent=2) + "\n", encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("apk", type=Path)
    parser.add_argument("mapping", type=Path)
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--r8-jar", type=Path)
    args = parser.parse_args()
    restore(args.apk.resolve(), args.mapping.resolve(), args.input.resolve(),
            args.output.resolve(), args.r8_jar)


if __name__ == "__main__":
    main()
