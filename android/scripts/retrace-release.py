#!/usr/bin/env python3
"""Restore Release diagnostics with the matching APK, gzip map and AGP Retrace.

Usage: retrace-release.py APK MAPPING.txt.gz INPUT OUTPUT_DIRECTORY [--r8-jar JAR]
INPUT is a stack-trace file or managed-device results directory. Original files
are never rewritten. Manual lookup requires the README's JDK/SDK setup and the
pinned Gradle. With --ci-logcat, INPUT is threadtime logcat and the tool is
resolved from the APK's verified R8 version without Gradle.
"""

import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tempfile

from release_mapping import read_release_mapping


ANDROID_RUNTIME = re.compile(
    r"^\d\d-\d\d \d\d:\d\d:\d\d\.\d+\s+(\d+)\s+(\d+)\s+E AndroidRuntime\s*:\s?(.*)$"
)


def logcat_stacks(path):
    def app_crash(lines):
        return any(
            line.startswith(("Process: ai.okou.android,", "Process: ai.okou.android:"))
            for line in lines
        ) and any(line.lstrip().startswith("at ") for line in lines)

    pending = {}
    with path.open(encoding="utf-8", errors="replace") as log:
        for line in log:
            record = ANDROID_RUNTIME.match(line.rstrip("\r\n"))
            if record is None:
                continue
            pid, tid, message = record.groups()
            thread = (pid, tid)
            if message.startswith("FATAL EXCEPTION:"):
                previous = pending.get(thread, ())
                if app_crash(previous):
                    yield "\n".join(previous)
                pending[thread] = [message]
            elif thread in pending:
                pending[thread].append(message)
    for lines in pending.values():
        if app_crash(lines):
            yield "\n".join(lines)


def download_r8(compiler, directory):
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", compiler):
        raise ValueError(f"Unsupported Google Maven R8 version: {compiler!r}")
    jar = directory / f"r8-{compiler}.jar"
    url = f"https://dl.google.com/dl/android/maven2/com/android/tools/r8/{compiler}/{jar.name}"
    subprocess.run(
        ["curl", "--fail", "--silent", "--show-error", "--max-time", "10",
         "--output", str(jar), url], check=True,
    )
    return jar


def sha256(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def restore(apk, mapping_gz, source, output, r8_jar, *, r8_download_dir=None):
    mapping, compiler, map_id = read_release_mapping(apk, mapping_gz)

    if r8_jar is None and r8_download_dir is not None:
        r8_jar = download_r8(compiler, r8_download_dir)
    elif r8_jar is None:
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


def restore_ci_logcat(apk, mapping, source, output, r8_jar):
    traces = list(dict.fromkeys(logcat_stacks(source)))
    if not traces:
        print("No Release app crash stacks to restore")
        return

    output.mkdir(parents=True, exist_ok=False)
    stack_file = output / "stack-traces.txt"
    stack_file.write_text("\n\n".join(traces) + "\n", encoding="utf-8")
    print(f"Restoring {len(traces)} distinct Release app crash stacks", flush=True)
    with tempfile.TemporaryDirectory(prefix="okou-retrace-r8-") as directory:
        restore(apk, mapping, stack_file, output / "app", r8_jar, r8_download_dir=Path(directory))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("apk", type=Path)
    parser.add_argument("mapping", type=Path)
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--r8-jar", type=Path)
    parser.add_argument("--ci-logcat", action="store_true",
                        help="Extract app Java crash stacks from threadtime logcat")
    args = parser.parse_args()
    paths = (args.apk.resolve(), args.mapping.resolve(), args.input.resolve(), args.output.resolve())
    restore_input = restore_ci_logcat if args.ci_logcat else restore
    restore_input(*paths, args.r8_jar)


if __name__ == "__main__":
    main()
