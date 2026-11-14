#!/usr/bin/env python3
"""Run one committed recipe; collect its declared Test Storage PNGs before publication.

Run from the repository root. Outputs replace android/build/screenshots only.
The recipe inherits OKOU_SCREENSHOT_RUN and uses capture-screenshot-scenario.sh.
No production credentials are required. A failed recipe or incomplete bundle exits nonzero.
"""

import argparse
import hashlib
import html
import json
import os
from pathlib import Path
import re
import shutil
import signal
import struct
import subprocess
import sys
import uuid
import zlib


ROOT = Path(__file__).resolve().parents[2]
RECIPES = ROOT / "android/screenshots"
OUTPUT = ROOT / "android/build/screenshots"
RAW = ROOT / "android/app/build/outputs/managed_device_android_test_additional_output"
SHA = re.compile(r"[0-9a-f]{40}")
IMAGE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*\.png")


def confined(path, parent):
    resolved = path.resolve(strict=True)
    if not resolved.is_relative_to(parent) or resolved == parent:
        raise ValueError(f"Path must be inside {parent.relative_to(ROOT)}")
    return resolved


def image_names(names):
    if not names or len(names) != len(set(names)) or any(not IMAGE.fullmatch(n) for n in names):
        raise ValueError("Declare distinct required PNG basenames")
    return names


def scenario_directory(value, names):
    image_names(names)
    directory = confined(Path(value), RECIPES)
    source = confined(directory / "src", directory)
    if not source.is_dir():
        raise ValueError("Scenario has no src directory")
    return directory


def png_size(path):
    """Check PNG framing, CRCs and complete non-interlaced scanlines (no golden comparison)."""
    data = path.read_bytes()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError(f"Invalid PNG: {path.name}")
    offset, header, compressed, ended = 8, None, bytearray(), False
    while offset < len(data):
        if offset + 12 > len(data):
            raise ValueError("Truncated PNG chunk")
        size = struct.unpack_from(">I", data, offset)[0]
        kind = data[offset + 4:offset + 8]
        end = offset + size + 12
        if end > len(data):
            raise ValueError("Truncated PNG payload")
        payload = data[offset + 8:end - 4]
        if zlib.crc32(kind + payload) != struct.unpack_from(">I", data, end - 4)[0]:
            raise ValueError("PNG checksum mismatch")
        if header is None and kind != b"IHDR":
            raise ValueError("PNG header is missing")
        if kind == b"IHDR":
            if header is not None or size != 13:
                raise ValueError("Invalid PNG header")
            header = struct.unpack(">IIBBBBB", payload)
        elif kind == b"IDAT":
            compressed.extend(payload)
        elif kind == b"IEND":
            if size or end != len(data):
                raise ValueError("Invalid PNG end")
            ended = True
        offset = end
    if not ended or not header or not compressed:
        raise ValueError("Incomplete PNG")
    width, height, depth, color, compression, filtering, interlace = header
    channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}.get(color)
    if not width or not height or not channels or depth not in (1, 2, 4, 8, 16):
        raise ValueError("Invalid PNG dimensions/format")
    if compression or filtering or interlace:
        raise ValueError("Expected a non-interlaced device PNG")
    stride = (width * channels * depth + 7) // 8 + 1
    expected = stride * height
    decoder = zlib.decompressobj()
    pixels = decoder.decompress(compressed, expected + 1)
    if len(pixels) != expected or not decoder.eof or decoder.unused_data:
        raise ValueError("Incomplete PNG image data")
    if any(pixels[row * stride] > 4 for row in range(height)):
        raise ValueError("Invalid PNG scanline")
    return width, height


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def collect(names):
    names = image_names(names)
    run_id = os.environ["OKOU_SCREENSHOT_RUN"]
    images = []
    destination = OUTPUT / "images"
    destination.mkdir(parents=True, exist_ok=True)
    for name in names:
        matches = []
        for path in RAW.rglob(name):
            metadata_path = path.with_name(name + ".json")
            if metadata_path.is_file():
                metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
                if metadata.get("runId") == run_id:
                    matches.append((path, metadata))
        if len(matches) != 1:
            raise ValueError(f"Expected exactly one current capture: {name}; found {len(matches)}")
        path, metadata = matches[0]
        width, height = png_size(path)
        if (metadata.get("width"), metadata.get("height")) != (width, height):
            raise ValueError(f"Capture dimensions disagree: {name}")
        shutil.copyfile(path, destination / name)
        images.append({"file": "images/" + name, "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                       "device": metadata})
    write_json(OUTPUT / "screenshots.json", {"runId": run_id, "images": images})
    cards = "\n".join(f'<figure><a href="{i["file"]}"><img src="{i["file"]}" '
                      f'style="max-width:360px"></a><figcaption>{html.escape(Path(i["file"]).name)}'
                      '</figcaption></figure>' for i in images)
    (OUTPUT / "index.html").write_text(
        '<!doctype html><meta charset="utf-8"><title>Android screenshots</title>'
        '<h1>Android screenshots</h1><p>Source and execution: <a href="run.json">run.json</a>; '
        '<a href="screenshots.json">device metadata</a></p>' + cards, encoding="utf-8")


def verify_bundle(run_id):
    bundle = json.loads((OUTPUT / "screenshots.json").read_text(encoding="utf-8"))
    if bundle.get("runId") != run_id or not bundle.get("images"):
        raise ValueError("Recipe produced no current screenshot bundle")
    for image in bundle["images"]:
        path = confined(OUTPUT / image["file"], OUTPUT / "images")
        width, height = png_size(path)
        device = image["device"]
        if device.get("runId") != run_id or (device.get("width"), device.get("height")) != (width, height):
            raise ValueError("Screenshot device metadata differs from this capture")
        if hashlib.sha256(path.read_bytes()).hexdigest() != image["sha256"]:
            raise ValueError("Screenshot changed after collection")


def execute(args):
    if not SHA.fullmatch(args.commit) or not SHA.fullmatch(args.driver):
        raise ValueError("Target and driver must be full lowercase commit SHAs")
    actual = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    if actual != args.commit:
        raise ValueError("Checked-out HEAD differs from requested commit")
    if subprocess.check_output(["git", "status", "--porcelain"], cwd=ROOT, text=True).strip():
        raise ValueError("Commit-addressed captures require a clean checkout")
    requested = Path(args.script)
    if requested.is_absolute() or ".." in requested.parts or requested.suffix != ".sh":
        raise ValueError("Select a repository-relative .sh recipe")
    script = confined(ROOT / requested, RECIPES)
    if not script.is_file():
        raise ValueError("Recipe is not a file")
    script_bytes = script.read_bytes()
    committed = subprocess.run(
        ["git", "cat-file", "blob", f"{actual}:{script.relative_to(ROOT).as_posix()}"],
        cwd=ROOT, capture_output=True)
    if committed.returncode or committed.stdout != script_bytes:
        raise ValueError("Recipe must match a file stored in the requested commit")
    if OUTPUT.resolve() != OUTPUT:
        raise ValueError("Screenshot output directory must not be a symlink")
    if OUTPUT.exists():
        shutil.rmtree(OUTPUT)
    OUTPUT.mkdir(parents=True)
    run_id = uuid.uuid4().hex
    metadata = {"commitSha": actual, "driverSha": args.driver, "scriptPath": args.script,
                "scriptSha256": hashlib.sha256(script_bytes).hexdigest(), "runId": run_id,
                "status": "failed"}
    env = {**os.environ, "OKOU_SCREENSHOT_RUN": run_id, "OKOU_SCREENSHOT_OUTPUT": str(OUTPUT)}
    process = None
    def interrupt(*_):
        raise KeyboardInterrupt()

    previous = signal.signal(signal.SIGTERM, interrupt)
    try:
        with (OUTPUT / "recipe.log").open("wb") as log:
            process = subprocess.Popen(["bash", str(script)], cwd=ROOT, env=env,
                                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                       start_new_session=True)
            for line in process.stdout:
                log.write(line)
                sys.stdout.buffer.write(line)
                sys.stdout.buffer.flush()
            code = process.wait()
        metadata["recipeExitCode"] = code
        if code:
            return code if code > 0 else 128 - code
        verify_bundle(run_id)
        metadata["status"] = "success"
        return 0
    except (ValueError, OSError, KeyError, zlib.error) as error:
        metadata["error"] = str(error)
        raise
    finally:
        signal.signal(signal.SIGTERM, previous)
        if process is not None:
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                # The recipe group has already exited, so no termination is needed.
                pass
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
            finally:
                # A recipe must not leave background descendants or an open log pipe behind.
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    # No background descendants remain once the group has exited.
                    pass
                process.stdout.close()
        write_json(OUTPUT / "run.json", metadata)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    run = commands.add_parser("run")
    for name in ("commit", "driver", "script"):
        run.add_argument("--" + name, required=True)
    validate = commands.add_parser("validate")
    validate.add_argument("directory")
    validate.add_argument("images", nargs="+")
    gather = commands.add_parser("collect")
    gather.add_argument("images", nargs="+")
    args = parser.parse_args()
    try:
        if args.command == "run":
            return execute(args)
        if args.command == "validate":
            print(scenario_directory(args.directory, args.images))
        else:
            collect(args.images)
        return 0
    except (ValueError, OSError, KeyError, zlib.error) as error:
        print(f"Screenshot capture failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
