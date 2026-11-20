#!/usr/bin/env python3
"""Restore Release diagnostics with the matching APK, gzip map and AGP Retrace.

Usage: retrace-release.py APK MAPPING.txt.gz INPUT OUTPUT_DIRECTORY [--r8-jar JAR]
INPUT is a stack-trace file or managed-device results directory. Original files
are never rewritten. Requires the README's JDK/SDK setup and the pinned Gradle.
"""

import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile

from release_mapping import read_release_mapping


def sha256(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def restore(apk, mapping_gz, source, output, r8_jar):
    mapping, compiler, map_id = read_release_mapping(apk, mapping_gz)

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
